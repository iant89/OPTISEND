/**
 * Engine save/restore (spec §9.5, §15.2 "page reloads during reception").
 * structuredClone mimics what IndexedDB does to the saved state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesEqual } from '../src/crypto/bytes.ts';
import { sha256 } from '../src/crypto/sha256.ts';
import { chunkRange } from '../src/protocol/chunking.ts';
import { MemoryChunkStore } from '../src/protocol/chunk-store.ts';
import { encodeDataPacket } from '../src/protocol/packet.ts';
import { ReceiverEngine, type PersistedSession } from '../src/protocol/receiver.ts';
import { allDataPackets, collect, makeBytes, plan, SID, SID_HEX } from './helpers.ts';

const save = (e: ReceiverEngine): PersistedSession[] => structuredClone(e.sessionIds().map((id) => e.exportSession(id)!));
const file = (e: ReceiverEngine, id = 0) => e.snapshot()[0]!.files.find((f) => f.fileId === id)!;

test('partial transfer survives a "reload": progress, names and bitmap restored; transfer completes', async () => {
  const data = makeBytes(1000, 1);
  const p = await plan([{ name: 'photo.jpg', data, mimeType: 'image/jpeg' }]);
  const store = new MemoryChunkStore();
  const a = new ReceiverEngine({ store });
  await a.ingest(p.manifestPackets[0]!);
  const pk = await allDataPackets(p);
  for (const i of [0, 2, 5, 9]) await a.ingest(pk[i]!);
  const saved = save(a);

  const b = new ReceiverEngine({ store }); // new page, same storage
  const report = await b.restore(saved);
  assert.deepEqual(report, { sessions: 1, files: 1, lostChunks: 0, recoveredChunks: 0, discarded: 0 });
  const f = file(b);
  assert.equal(f.name, 'photo.jpg');
  assert.equal(f.mimeType, 'image/jpeg');
  assert.equal(f.receivedChunks, 4);
  assert.equal(f.storedBytes, 400);
  assert.deepEqual([...b.bitmap(SID_HEX, 0)!.missing()], [1, 3, 4, 6, 7, 8]);
  // Restored chunks are duplicates; the rest complete the file.
  for (const pkt of pk) await b.ingest(pkt);
  assert.equal(b.stats.duplicates, 4);
  assert.equal(file(b).status, 'verified');
  assert.ok(bytesEqual(await collect(b.readFile(SID_HEX, 0)), data));
});

test('verified files survive a reload and can still be read', async () => {
  const data = makeBytes(777, 2);
  const p = await plan([{ name: 'a.bin', data }]);
  const store = new MemoryChunkStore();
  const a = new ReceiverEngine({ store });
  for (const pkt of await allDataPackets(p)) await a.ingest(pkt);
  const b = new ReceiverEngine({ store });
  await b.restore(save(a));
  assert.equal(file(b).status, 'verified');
  assert.ok(bytesEqual(await collect(b.readFile(SID_HEX, 0)), data));
});

test('chunks evicted by the browser are detected and re-requested, never assumed', async () => {
  const p = await plan([{ name: 'e.bin', data: makeBytes(500, 3) }]);
  const store = new MemoryChunkStore();
  const a = new ReceiverEngine({ store });
  const pk = await allDataPackets(p);
  for (const pkt of pk) await a.ingest(pkt);
  assert.equal(file(a).status, 'verified');
  const saved = save(a);
  store.evict({ sessionId: SID_HEX, fileId: 0, chunkIndex: 2 });
  const b = new ReceiverEngine({ store });
  const r = await b.restore(saved);
  assert.equal(r.lostChunks, 1);
  assert.equal(file(b).status, 'receiving', 'a file with a lost chunk is no longer verified');
  assert.deepEqual([...b.bitmap(SID_HEX, 0)!.missing()], [2]);
  await b.ingest(pk[2]!);
  assert.equal(file(b).status, 'verified');
});

test('chunks written after the last metadata save are recovered from storage (crash safety)', async () => {
  const data = makeBytes(600, 4);
  const p = await plan([{ name: 'c.bin', data }]);
  const store = new MemoryChunkStore();
  const a = new ReceiverEngine({ store });
  const pk = await allDataPackets(p);
  for (const pkt of pk.slice(0, 2)) await a.ingest(pkt);
  const stale = save(a); // metadata saved here…
  for (const pkt of pk.slice(2)) await a.ingest(pkt); // …then the page died before saving again
  const b = new ReceiverEngine({ store });
  const r = await b.restore(stale);
  assert.equal(r.recoveredChunks, 4);
  assert.equal(file(b).status, 'verified', 'recovery completes the file and runs the full-file check');
  assert.ok(bytesEqual(await collect(b.readFile(SID_HEX, 0)), data));
});

test('restored fingerprints still detect conflicting chunks', async () => {
  const data = makeBytes(300, 5);
  const p = await plan([{ name: 'k', data }]);
  const store = new MemoryChunkStore();
  const a = new ReceiverEngine({ store });
  await a.ingest((await allDataPackets(p))[0]!);
  const b = new ReceiverEngine({ store });
  await b.restore(save(a));
  const r = chunkRange(300, 100, 0);
  const forged = makeBytes(r.length, 99);
  const res = await b.ingest(encodeDataPacket({ sessionId: SID, fileId: 0, fileSize: 300, chunkSize: 100, chunkIndex: 0, fileHash: p.files[0]!.fileHash, chunkHash: sha256(forged), payload: forged }));
  assert.equal(res.status, 'conflict');
});

test('hash-mismatch state persists until the user resets the file', async () => {
  const data = makeBytes(200, 6);
  const wrong = sha256(makeBytes(200, 7));
  const store = new MemoryChunkStore();
  const a = new ReceiverEngine({ store });
  for (let i = 0; i < 2; i++) {
    const r = chunkRange(200, 100, i);
    const payload = data.subarray(r.start, r.end);
    await a.ingest(encodeDataPacket({ sessionId: SID, fileId: 0, fileSize: 200, chunkSize: 100, chunkIndex: i, fileHash: wrong, chunkHash: sha256(payload), payload }));
  }
  assert.equal(file(a).status, 'hash-mismatch');
  const b = new ReceiverEngine({ store });
  await b.restore(save(a));
  assert.equal(file(b).status, 'hash-mismatch');
});

test('deleted files stay deleted: chunks removed, later packets and manifests ignored, even after reload', async () => {
  const p = await plan([{ name: 'keep.txt', data: makeBytes(300, 8) }, { name: 'drop.txt', data: makeBytes(300, 9) }]);
  const store = new MemoryChunkStore();
  const a = new ReceiverEngine({ store });
  await a.ingest(p.manifestPackets[0]!);
  const pk = await allDataPackets(p);
  for (const pkt of pk) await a.ingest(pkt);
  await a.removeFile(SID_HEX, 1);
  assert.equal((await store.listChunks(SID_HEX, 1)).size, 0);
  assert.equal(a.snapshot()[0]!.files.length, 1);
  assert.ok(a.snapshot()[0]!.allFilesKnown);
  assert.ok(a.snapshot()[0]!.complete, 'remaining files complete the transfer');
  const b = new ReceiverEngine({ store });
  await b.restore(save(a));
  await b.ingest(p.manifestPackets[0]!);
  for (const pkt of pk) await b.ingest(pkt);
  assert.equal(b.snapshot()[0]!.files.length, 1, 'the sender still looping does not bring it back');
  assert.equal((await store.listChunks(SID_HEX, 1)).size, 0);
  // Deleting the last file hides the transfer.
  await b.removeFile(SID_HEX, 0);
  assert.equal(b.snapshot().length, 0);
});

test('corrupt saved records are discarded, valid ones kept', async () => {
  const p = await plan([{ name: 'ok', data: makeBytes(100, 10) }]);
  const store = new MemoryChunkStore();
  const a = new ReceiverEngine({ store });
  for (const pkt of await allDataPackets(p)) await a.ingest(pkt);
  const good = save(a)[0]!;
  const badFile = { ...good, id: '1111111111111111', files: [{ ...good.files[0]!, chunkCount: 99 }] };
  const badSession = { ...good, id: 'not-hex' };
  const b = new ReceiverEngine({ store });
  const r = await b.restore([good, badFile as PersistedSession, badSession as PersistedSession, null as unknown as PersistedSession]);
  assert.equal(r.sessions, 2);
  assert.equal(r.files, 1);
  assert.equal(r.discarded, 3);
});

test('change notifications fire for state changes, not for duplicates or rejects', async () => {
  const p = await plan([{ name: 'n', data: makeBytes(200, 11) }]);
  const e = new ReceiverEngine({ store: new MemoryChunkStore() });
  const seen: string[] = [];
  e.onChange((sid) => seen.push(sid));
  const pk = await allDataPackets(p);
  await e.ingest(p.manifestPackets[0]!);
  await e.ingest(pk[0]!);
  await e.ingest(pk[0]!); // duplicate
  await e.ingest(new TextEncoder().encode('junk junk junk junk junk')); // rejected
  assert.equal(seen.length, 2);
  await e.removeFile(SID_HEX, 0);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => s === SID_HEX));
});

test('finished transfers do not count against the in-progress limit', async () => {
  const e = new ReceiverEngine({ store: new MemoryChunkStore(), limits: { maxActiveSessions: 1 } });
  const mk = (n: number) => Uint8Array.from([n, n, n, n, n, n, n, n]);
  for (let n = 1; n <= 3; n++) {
    const p = await plan([{ name: `f${n}`, data: makeBytes(150, n) }], 100, { sessionId: mk(n) });
    for (const pkt of await allDataPackets(p)) assert.equal((await e.ingest(pkt)).status, 'accepted');
  }
  assert.equal(e.snapshot().length, 3, 'all finished transfers remain listed');
});
