import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesEqual } from '../src/crypto/bytes.ts';
import { sha256 } from '../src/crypto/sha256.ts';
import { crc32 } from '../src/crypto/crc32.ts';
import { DATA_HEADER_BYTES } from '../src/protocol/constants.ts';
import { chunkRange } from '../src/protocol/chunking.ts';
import { MemoryChunkStore, type ChunkStore } from '../src/protocol/chunk-store.ts';
import { encodeDataPacket, encodeManifestPacket } from '../src/protocol/packet.ts';
import { ReceiverEngine, type IngestResult } from '../src/protocol/receiver.ts';
import { allDataPackets, collect, makeBytes, plan, seededShuffle, SID, SID_HEX } from './helpers.ts';

function engine(store: ChunkStore = new MemoryChunkStore(), limits = {}) {
  return new ReceiverEngine({ store, limits });
}

async function feed(rx: ReceiverEngine, packets: Uint8Array[]): Promise<IngestResult[]> {
  const out: IngestResult[] = [];
  for (const p of packets) out.push(await rx.ingest(p));
  return out;
}

function file(rx: ReceiverEngine, fileId = 0, sid = SID_HEX) {
  const s = rx.snapshot().find((x) => x.sessionId === sid);
  const f = s?.files.find((x) => x.fileId === fileId);
  assert.ok(f, `file ${fileId} in session ${sid}`);
  return f;
}

/** Forge a packet with a self-consistent (valid) chunk hash but different data. */
function forgeChunk(fileSize: number, chunkSize: number, index: number, fileHash: Uint8Array, seed: number, fileId = 0, sessionId = SID) {
  const r = chunkRange(fileSize, chunkSize, index);
  const payload = makeBytes(r.length, seed);
  return encodeDataPacket({ sessionId, fileId, fileSize, chunkSize, chunkIndex: index, fileHash, chunkHash: sha256(payload), payload });
}

// ─── Acceptance criterion 1: byte-for-byte reconstruction ───

test('in-order reception reconstructs byte-for-byte and verifies', async () => {
  const data = makeBytes(10_007, 5);
  const p = await plan([{ name: 'photo.jpg', data, mimeType: 'image/jpeg' }]);
  const rx = engine();
  await rx.ingest(p.manifestPackets[0]!);
  const results = await feed(rx, await allDataPackets(p));
  assert.ok(results.every((r) => r.status === 'accepted'));
  const f = file(rx);
  assert.equal(f.status, 'verified');
  assert.equal(f.progress, 1);
  assert.equal(f.name, 'photo.jpg');
  assert.equal(f.mimeType, 'image/jpeg');
  assert.ok(bytesEqual(await collect(rx.readFile(SID_HEX, 0)), data));
  const s = rx.snapshot()[0]!;
  assert.ok(s.complete);
  assert.equal(s.progress, 1);
});

test('out-of-order reception (shuffled) reconstructs identically', async () => {
  const data = makeBytes(5_555, 6);
  const p = await plan([{ name: 'x', data }]);
  const rx = engine();
  await feed(rx, seededShuffle(await allDataPackets(p), 99));
  assert.equal(file(rx).status, 'verified');
  assert.ok(bytesEqual(await collect(rx.readFile(SID_HEX, 0)), data));
});

test('data before manifest: provisional entry, reconciled when the manifest arrives (spec §7.1)', async () => {
  const p = await plan([{ name: 'late-manifest.txt', data: makeBytes(500) }]);
  const rx = engine();
  const packets = await allDataPackets(p);
  await feed(rx, packets.slice(0, 2));
  let f = file(rx);
  assert.equal(f.hasManifest, false);
  assert.equal(f.name, null);
  assert.equal(f.displayName, 'file-1');
  assert.equal(rx.snapshot()[0]!.allFilesKnown, false);
  const r = await rx.ingest(p.manifestPackets[0]!);
  assert.equal(r.status, 'manifest');
  f = file(rx);
  assert.equal(f.hasManifest, true);
  assert.equal(f.name, 'late-manifest.txt');
  await feed(rx, packets.slice(2));
  assert.equal(file(rx).status, 'verified');
});

test('file completes and verifies even if the manifest is never seen', async () => {
  const data = makeBytes(321);
  const p = await plan([{ name: 'n', data }]);
  const rx = engine();
  await feed(rx, await allDataPackets(p));
  assert.equal(file(rx).status, 'verified');
  // But the session is not "complete" — without a manifest we cannot know there are no other files.
  assert.equal(rx.snapshot()[0]!.complete, false);
});

// ─── Criteria 2 & 7: missing chunks ───

test('missing chunks are tracked and the file never completes without them', async () => {
  const data = makeBytes(1000);
  const p = await plan([{ name: 'm', data }]);
  const rx = engine();
  const packets = await allDataPackets(p);
  await feed(rx, packets.filter((_, i) => i !== 3 && i !== 7));
  const f = file(rx);
  assert.equal(f.status, 'receiving');
  assert.equal(f.receivedChunks, 8);
  assert.equal(f.missingChunks, 2);
  assert.equal(f.storedBytes, 800);
  assert.equal(f.progress, 0.8);
  assert.deepEqual([...rx.bitmap(SID_HEX, 0)!.missing()], [3, 7]);
  await assert.rejects(collect(rx.readFile(SID_HEX, 0)), /not verified/);
  // Retransmission (next pass) fills the gaps.
  await feed(rx, [packets[3]!, packets[7]!]);
  assert.equal(file(rx).status, 'verified');
});

// ─── Criterion 3: corrupt chunks ───

test('corrupt payload is rejected by chunk hash and never stored', async () => {
  const p = await plan([{ name: 'c', data: makeBytes(300) }]);
  const store = new MemoryChunkStore();
  const rx = engine(store);
  const pkt = (await allDataPackets(p))[1]!;
  const bad = pkt.slice();
  bad[DATA_HEADER_BYTES + 10]! ^= 0x01;
  const r = await rx.ingest(bad);
  assert.equal(r.status, 'rejected');
  assert.equal(r.status === 'rejected' && r.reason, 'chunk-hash-mismatch');
  assert.equal(store.usedBytes, 0);
  assert.equal(rx.snapshot().length, 0, 'a corrupt first packet must not create session state');
  assert.equal(rx.stats.rejectReasons['chunk-hash-mismatch'], 1);
  // The genuine packet is still accepted afterwards.
  assert.equal((await rx.ingest(pkt)).status, 'accepted');
});

test('a rejected packet never overwrites a validated chunk', async () => {
  const data = makeBytes(300);
  const p = await plan([{ name: 'c', data }]);
  const rx = engine();
  const packets = await allDataPackets(p);
  await rx.ingest(packets[1]!);
  const bad = packets[1]!.slice();
  bad[DATA_HEADER_BYTES]! ^= 0xff;
  // Now a known chunk: hash comparison against the stored fingerprint flags a conflict? No —
  // the *declared* hash still matches the stored one, so it is classified as a duplicate and ignored
  // without hashing. Either way nothing is written.
  const r = await rx.ingest(bad);
  assert.ok(r.status === 'duplicate' || r.status === 'rejected');
  await feed(rx, [packets[0]!, packets[2]!]);
  assert.equal(file(rx).status, 'verified');
  assert.ok(bytesEqual(await collect(rx.readFile(SID_HEX, 0)), data));
});

test('random corruption fuzz: never accepted, never crashes, never corrupts output', async () => {
  const data = makeBytes(2000, 77);
  const p = await plan([{ name: 'fuzz', data }]);
  const rx = engine();
  const packets = await allDataPackets(p);
  let x = 4242;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x);
  for (let k = 0; k < 2000; k++) {
    const b = packets[rnd() % packets.length]!.slice();
    b[rnd() % b.length] = rnd() & 0xff;
    const r = await rx.ingest(b);
    assert.notEqual(r.status, 'storage-error');
  }
  await feed(rx, packets);
  assert.equal(file(rx).status, 'verified');
  assert.ok(bytesEqual(await collect(rx.readFile(SID_HEX, 0)), data));
});

// ─── Criterion 4: duplicates ───

test('duplicates never inflate progress and are counted separately', async () => {
  const p = await plan([{ name: 'd', data: makeBytes(1000) }]);
  const rx = engine();
  const packets = await allDataPackets(p);
  for (let pass = 0; pass < 3; pass++) await feed(rx, packets.slice(0, 5));
  const f = file(rx);
  assert.equal(f.receivedChunks, 5);
  assert.equal(f.storedBytes, 500);
  assert.equal(f.progress, 0.5);
  assert.equal(rx.stats.accepted, 5);
  assert.equal(rx.stats.duplicates, 10);
  // Duplicates of a verified file are ignored too.
  await feed(rx, packets);
  await feed(rx, packets);
  assert.equal(file(rx).storedBytes, 1000);
  assert.equal(file(rx).progress, 1);
});

test('repeated manifests are duplicates, not new state', async () => {
  const p = await plan([{ name: 'm', data: makeBytes(10) }]);
  const rx = engine();
  assert.equal((await rx.ingest(p.manifestPackets[0]!)).status, 'manifest');
  assert.equal((await rx.ingest(p.manifestPackets[0]!)).status, 'duplicate');
});

test('concurrent duplicate while a write is in flight is not double-counted', async () => {
  const p = await plan([{ name: 'cc', data: makeBytes(200) }]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inner = new MemoryChunkStore();
  const slow: ChunkStore = {
    put: async (k, d) => { await gate; return inner.put(k, d); },
    get: (k) => inner.get(k), deleteFile: (s, f) => inner.deleteFile(s, f), deleteSession: (s) => inner.deleteSession(s), listChunks: (s, f) => inner.listChunks(s, f),
  };
  const rx = engine(slow);
  const pkt = (await allDataPackets(p))[0]!;
  const a = rx.ingest(pkt);
  const b = rx.ingest(pkt);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.status, rb.status].sort(), ['accepted', 'duplicate']);
  assert.equal(file(rx).storedBytes, 100);
});

// ─── Criterion 5: file isolation ───

test('files with identical names stay isolated (keyed by id, not name)', async () => {
  const a = makeBytes(450, 1);
  const b = makeBytes(450, 2);
  const p = await plan([{ name: 'same.txt', data: a }, { name: 'same.txt', data: b }]);
  const rx = engine();
  await rx.ingest(p.manifestPackets[0]!);
  await feed(rx, seededShuffle(await allDataPackets(p), 3));
  assert.equal(file(rx, 0).status, 'verified');
  assert.equal(file(rx, 1).status, 'verified');
  assert.ok(bytesEqual(await collect(rx.readFile(SID_HEX, 0)), a));
  assert.ok(bytesEqual(await collect(rx.readFile(SID_HEX, 1)), b));
  assert.ok(rx.snapshot()[0]!.complete);
});

test('two concurrent sessions with the same file ids never mix', async () => {
  const sid2 = Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]);
  const a = makeBytes(300, 10);
  const b = makeBytes(300, 20);
  const p1 = await plan([{ name: 'f', data: a }]);
  const p2 = await plan([{ name: 'f', data: b }], 100, { sessionId: sid2 });
  const rx = engine();
  const mixed = seededShuffle([...(await allDataPackets(p1)), ...(await allDataPackets(p2))], 5);
  await feed(rx, mixed);
  assert.equal(rx.snapshot().length, 2);
  assert.ok(bytesEqual(await collect(rx.readFile(SID_HEX, 0)), a));
  assert.ok(bytesEqual(await collect(rx.readFile('0909090909090909', 0)), b));
});

test('a chunk with conflicting content for a validated index keeps the stored data (spec §6.6)', async () => {
  const data = makeBytes(300, 1);
  const p = await plan([{ name: 'k', data }]);
  const rx = engine();
  const packets = await allDataPackets(p);
  await rx.ingest(packets[0]!);
  const forged = forgeChunk(300, 100, 0, p.files[0]!.fileHash, 999);
  const r = await rx.ingest(forged);
  assert.equal(r.status, 'conflict');
  assert.equal(file(rx).conflicts, 1);
  await feed(rx, packets.slice(1));
  assert.equal(file(rx).status, 'verified');
  assert.ok(bytesEqual(await collect(rx.readFile(SID_HEX, 0)), data));
});

test('conflicting file metadata for an existing file id is refused', async () => {
  const p = await plan([{ name: 'k', data: makeBytes(300) }]);
  const rx = engine();
  await rx.ingest((await allDataPackets(p))[0]!);
  // Same session + file id, different declared file size.
  const r1 = await rx.ingest(forgeChunk(400, 100, 1, p.files[0]!.fileHash, 5));
  assert.equal(r1.status, 'conflict');
  // Different declared file hash.
  const r2 = await rx.ingest(forgeChunk(300, 100, 1, sha256(new Uint8Array([1])), 5));
  assert.equal(r2.status, 'conflict');
  assert.equal(file(rx).receivedChunks, 1);
});

test('conflicting manifests are refused atomically', async () => {
  const p = await plan([{ name: 'a', data: makeBytes(300) }, { name: 'b', data: makeBytes(300, 2) }]);
  const rx = engine();
  await rx.ingest(p.manifestPackets[0]!);
  const base = { sessionId: SID, partIndex: 0, partCount: 1 };
  const e0 = { ...p.files[0]!, source: undefined };
  // Different file count.
  assert.equal((await rx.ingest(encodeManifestPacket({ ...base, fileCount: 3, entries: [e0] }))).status, 'conflict');
  // Different size for file 0.
  assert.equal((await rx.ingest(encodeManifestPacket({ ...base, fileCount: 2, entries: [{ ...e0, fileSize: 250, chunkCount: 3 }] }))).status, 'conflict');
  // Renamed file 0.
  assert.equal((await rx.ingest(encodeManifestPacket({ ...base, fileCount: 2, entries: [{ ...e0, name: 'evil.exe' }] }))).status, 'conflict');
  assert.equal(file(rx, 0).name, 'a');
});

test('data for a file id outside the manifest is refused', async () => {
  const p = await plan([{ name: 'a', data: makeBytes(100) }]);
  const rx = engine();
  await rx.ingest(p.manifestPackets[0]!);
  const r = await rx.ingest(forgeChunk(100, 100, 0, sha256(makeBytes(100, 3)), 3, 5));
  assert.equal(r.status, 'conflict');
});

// ─── Criterion 6: final hash mismatch ───

test('a complete file whose bytes do not match the full-file hash is never verified', async () => {
  const data = makeBytes(300);
  const wrongHash = sha256(makeBytes(300, 2));
  const rx = engine();
  for (let i = 0; i < 3; i++) {
    const r = chunkRange(300, 100, i);
    const payload = data.subarray(r.start, r.end);
    await rx.ingest(encodeDataPacket({ sessionId: SID, fileId: 0, fileSize: 300, chunkSize: 100, chunkIndex: i, fileHash: wrongHash, chunkHash: sha256(payload), payload }));
  }
  const f = file(rx);
  assert.equal(f.receivedChunks, 3);
  assert.equal(f.status, 'hash-mismatch');
  await assert.rejects(collect(rx.readFile(SID_HEX, 0)));
  assert.equal(rx.snapshot()[0]!.complete, false);
  // Recovery path: reset and receive again.
  await rx.resetFile(SID_HEX, 0);
  assert.equal(file(rx).receivedChunks, 0);
  assert.equal(file(rx).status, 'receiving');
});

// ─── Criterion 8: storage failures ───

test('a failed store write is not counted and the chunk stays eligible for retransmission', async () => {
  const data = makeBytes(1000);
  const p = await plan([{ name: 'q', data }]);
  const quota = new MemoryChunkStore(450);
  const rx = engine(quota);
  const packets = await allDataPackets(p);
  const results = await feed(rx, packets);
  assert.equal(results.filter((r) => r.status === 'accepted').length, 4);
  assert.equal(results.filter((r) => r.status === 'storage-error').length, 6);
  assert.equal(file(rx).storedBytes, 400);
  assert.equal(file(rx).receivedChunks, 4);
  assert.equal(rx.stats.storageFailures, 6);
});

test('chunks lost from storage before verification are re-requested, not assumed', async () => {
  const data = makeBytes(500);
  const p = await plan([{ name: 'e', data }]);
  const store = new MemoryChunkStore();
  const rx = engine(store);
  const packets = await allDataPackets(p);
  await feed(rx, packets.slice(0, 4));
  store.evict({ sessionId: SID_HEX, fileId: 0, chunkIndex: 1 });
  await rx.ingest(packets[4]!); // completes the bitmap -> verification finds chunk 1 missing
  const f = file(rx);
  assert.equal(f.status, 'receiving');
  assert.equal(f.receivedChunks, 4);
  assert.deepEqual([...rx.bitmap(SID_HEX, 0)!.missing()], [1]);
  await rx.ingest(packets[1]!);
  assert.equal(file(rx).status, 'verified');
  assert.ok(bytesEqual(await collect(rx.readFile(SID_HEX, 0)), data));
});

test('storage corruption after verification is detected on read', async () => {
  const p = await plan([{ name: 'r', data: makeBytes(300) }]);
  const store = new MemoryChunkStore();
  const rx = engine(store);
  await feed(rx, await allDataPackets(p));
  assert.equal(file(rx).status, 'verified');
  (await store.get({ sessionId: SID_HEX, fileId: 0, chunkIndex: 2 }))![0]! ^= 0xff;
  await assert.rejects(collect(rx.readFile(SID_HEX, 0)), /damaged/);
  assert.equal(file(rx).status, 'receiving');
});

// ─── Progress (spec §3.5) ───

test('multi-file progress = sum of unique stored bytes / sum of declared sizes', async () => {
  const p = await plan([{ name: 'a', data: makeBytes(1000) }, { name: 'b', data: makeBytes(500) }, { name: 'empty', data: new Uint8Array() }]);
  const rx = engine();
  await rx.ingest(p.manifestPackets[0]!);
  const packets = await allDataPackets(p);
  await feed(rx, [...packets.slice(0, 5), ...packets.slice(10, 12)]); // 500 of a, 200 of b
  const s = rx.snapshot()[0]!;
  assert.equal(s.totalBytes, 1500);
  assert.equal(s.storedBytes, 700);
  assert.equal(s.progress, 700 / 1500);
  assert.ok(s.allFilesKnown);
  assert.equal(s.files[2]!.progress, 0);
  await rx.ingest(packets[15]!); // the empty file's single zero-length chunk
  assert.equal(file(rx, 2).status, 'verified');
  assert.equal(file(rx, 2).progress, 1);
  assert.equal(rx.snapshot()[0]!.complete, false);
});

test('bitmap aggregation for large chunk counts keeps exact underlying state', async () => {
  const p = await plan([{ name: 'big', data: makeBytes(100_000) }], 10); // 10,000 chunks
  const rx = engine();
  const packets = await allDataPackets(p);
  await feed(rx, packets.filter((_, i) => i < 2500 || i % 2 === 0));
  const bm = rx.bitmap(SID_HEX, 0)!;
  assert.equal(bm.size, 10_000);
  assert.equal(bm.count, 2500 + 3750);
  const bars = bm.aggregate(4);
  assert.deepEqual([...bars], [1, 0.5, 0.5, 0.5]);
});

// ─── Resource limits (spec §12.3) ───

test('session and incomplete-file limits are enforced; verified sessions make room', async () => {
  const rx = engine(new MemoryChunkStore(), { maxActiveSessions: 2, maxIncompleteFiles: 3 });
  const mk = (n: number) => Uint8Array.from([n, n, n, n, n, n, n, n]);
  const p1 = await plan([{ name: 'a', data: makeBytes(200) }], 100, { sessionId: mk(1) });
  const p2 = await plan([{ name: 'b', data: makeBytes(200) }], 100, { sessionId: mk(2) });
  const p3 = await plan([{ name: 'c', data: makeBytes(200) }], 100, { sessionId: mk(3) });
  await rx.ingest((await allDataPackets(p1))[0]!);
  await rx.ingest((await allDataPackets(p2))[0]!);
  const r = await rx.ingest((await allDataPackets(p3))[0]!);
  assert.equal(r.status === 'rejected' && r.reason, 'limit-exceeded');
  // Completing session 1 frees a slot.
  await rx.ingest((await allDataPackets(p1))[1]!);
  assert.equal((await rx.ingest((await allDataPackets(p3))[0]!)).status, 'accepted');

  // Session 3 removed; session 2 has 1 incomplete file. Start 5 more files (chunk 0 of 2 each).
  const many = await plan(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: makeBytes(200, i + 1) })), 100, { sessionId: mk(4) });
  await rx.removeSession('0303030303030303');
  const res = await feed(rx, (await allDataPackets(many)).filter((_, i) => i % 2 === 0));
  assert.deepEqual(res.map((x) => x.status), ['accepted', 'accepted', 'rejected', 'rejected', 'rejected']);
  assert.ok(res.some((x) => x.status === 'rejected' && x.reason === 'limit-exceeded'));
});

test('listeners receive every result; header-only CRC is enforced end to end', async () => {
  const p = await plan([{ name: 'l', data: makeBytes(100) }]);
  const rx = engine();
  const seen: string[] = [];
  const off = rx.subscribe((r) => seen.push(r.status));
  const pkt = (await allDataPackets(p))[0]!;
  const badCrc = pkt.slice();
  const dv = new DataView(badCrc.buffer);
  dv.setUint32(DATA_HEADER_BYTES - 4, crc32(badCrc, 0, DATA_HEADER_BYTES - 4) ^ 1, false);
  await feed(rx, [new TextEncoder().encode('https://example.com/not-optisend'), badCrc, pkt, pkt]);
  off();
  await rx.ingest(pkt);
  assert.deepEqual(seen, ['rejected', 'rejected', 'accepted', 'duplicate']);
  assert.equal(rx.stats.packetsSeen, 5);
  assert.equal(rx.stats.rejectReasons['header-crc'], 1);
  assert.equal(rx.stats.rejectReasons['bad-magic'], 1);
});
