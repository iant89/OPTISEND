import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/crypto/sha256.ts';
import { blockLayout, blockRange, coefficients, encodeRepairPayload, hasBit, solveBlock, symbolLength, MAX_REPAIR_BLOCK } from '../src/protocol/fountain.ts';
import { chunkRange } from '../src/protocol/chunking.ts';
import { decodePacket, encodeRepairPacket, type RepairPacket } from '../src/protocol/packet.ts';
import { MemoryChunkStore } from '../src/protocol/chunk-store.ts';
import { ReceiverEngine, type IngestResult } from '../src/protocol/receiver.ts';
import { PacketType, REPAIR_HEADER_BYTES } from '../src/protocol/constants.ts';
import { ProtocolError } from '../src/protocol/errors.ts';
import { collect, makeBytes, plan, seededShuffle, SID, SID_HEX } from './helpers.ts';

const hex = (w: Uint32Array) => Array.from(w, (x) => x.toString(16).padStart(8, '0'));

test('coefficients are deterministic and match the normative generator (PROTOCOL.md §5a)', () => {
  assert.deepEqual(hex(coefficients(0, 0, 64)), ['43752703', '2e4a6726']);
  assert.deepEqual(hex(coefficients(3, 17, 40)), ['02c466e0', '000000b6']); // bits beyond n cleared
  assert.deepEqual(hex(coefficients(1, 0xffffffff, 33)), ['81a396cb', '00000000']);
  // Never empty: a 1-chunk block always uses its chunk.
  for (let s = 0; s < 64; s++) assert.ok(hasBit(coefficients(7, s, 1), 0));
  // About half the chunks per symbol.
  let set = 0;
  for (let s = 0; s < 200; s++) for (let j = 0; j < 100; j++) set += +hasBit(coefficients(2, s, 100), j);
  assert.ok(set > 9000 && set < 11000, `${set} of 20000`);
});

test('coefficients are not confined to a low-dimensional subspace (full rank over a 256-chunk block)', () => {
  // A linear generator (e.g. xorshift) caps the rank at its state size (32), so blocks with
  // more than 32 missing chunks could never be solved. Check the full 256 columns.
  const n = 256;
  const basis = new Map<number, Uint32Array>(); // pivot bit → row
  for (let id = 0; id < 300 && basis.size < n; id++) {
    const r = coefficients(9, id, n).slice();
    for (let j = 0; j < n; j++) {
      if (!hasBit(r, j)) continue;
      const b = basis.get(j);
      if (!b) { basis.set(j, r); break; }
      for (let w = 0; w < r.length; w++) r[w]! ^= b[w]!;
    }
  }
  assert.equal(basis.size, n);
});

test('block layout: blocks of at most 256 chunks, as equal as possible', () => {
  assert.deepEqual(blockLayout(1), { blockSize: 1, blockCount: 1 });
  assert.deepEqual(blockLayout(256), { blockSize: 256, blockCount: 1 });
  assert.deepEqual(blockLayout(257), { blockSize: 129, blockCount: 2 });
  assert.deepEqual(blockLayout(1000), { blockSize: 250, blockCount: 4 });
  assert.deepEqual(blockRange(257, 129, 1), { start: 129, end: 257 });
  // Symbol length is the block's first (longest) chunk.
  assert.equal(symbolLength(1000, 300, 2, 1), 300);
  assert.equal(symbolLength(250, 300, 1, 0), 250);
  assert.equal(symbolLength(0, 300, 1, 0), 0);
});

function randomChunks(n: number, len: number, lastLen: number, seed: number): Uint8Array[] {
  return Array.from({ length: n }, (_, j) => makeBytes(j === n - 1 ? lastLen : len, seed + j));
}

test('solveBlock rebuilds any missing chunks exactly from enough repair symbols', () => {
  for (const [n, missing, seed] of [[50, 10, 1], [256, 40, 2], [7, 7, 3], [1, 1, 4]] as const) {
    const chunks = randomChunks(n, 120, 77, seed);
    const unknown = seededShuffle(Array.from({ length: n }, (_, j) => j), seed).slice(0, missing).sort((a, b) => a - b);
    const symbols = [];
    let solved: Map<number, Uint8Array> | null = null;
    for (let id = 0; id < missing + 20 && !solved; id++) {
      const coefs = coefficients(5, id, n);
      symbols.push({ coefs, payload: encodeRepairPayload(chunks, coefs, 120) });
      solved = solveBlock(n, unknown, symbols, (j) => chunks[j]!);
    }
    assert.ok(solved, `n=${n} missing=${missing}`);
    assert.ok(symbols.length <= missing + 12, `needed ${symbols.length} symbols for ${missing} unknowns`);
    for (const j of unknown) assert.deepEqual([...solved.get(j)!.subarray(0, chunks[j]!.length)], [...chunks[j]!]);
  }
  // Fewer symbols than unknowns: not solvable yet.
  const chunks = randomChunks(10, 8, 8, 9);
  assert.equal(solveBlock(10, [1, 2, 3], [{ coefs: coefficients(0, 0, 10), payload: encodeRepairPayload(chunks, coefficients(0, 0, 10), 8) }], (j) => chunks[j]!), null);
});

test('repair packets round-trip and malformed ones are rejected', () => {
  const payload = makeBytes(300, 1);
  const pkt = encodeRepairPacket({ sessionId: SID, fileId: 2, fileSize: 1000, chunkSize: 300, blockIndex: 1, blockSize: 2, symbolId: 99, fileHash: sha256(new Uint8Array(1)), payloadHash: sha256(payload), payload });
  assert.equal(pkt.length, REPAIR_HEADER_BYTES + 300);
  const d = decodePacket(pkt) as RepairPacket;
  assert.equal(d.type, PacketType.Repair);
  assert.deepEqual([d.fileId, d.chunkCount, d.blockIndex, d.blockSize, d.symbolId], [2, 4, 1, 2, 99]);
  assert.deepEqual([...d.payload], [...payload]);
  const reject = (p: Uint8Array, reason: string) => assert.throws(() => decodePacket(p), (e: unknown) => e instanceof ProtocolError && e.reason === reason);
  // Re-seal a modified header so the CRC is not what rejects it.
  const forge = (mut: (dv: DataView) => void) => {
    const b = pkt.slice();
    const dv = new DataView(b.buffer);
    mut(dv);
    return b;
  };
  reject(forge((dv) => dv.setUint32(36, 2)), 'header-crc'); // block index changed without re-sealing
  assert.throws(() => encodeRepairPacket({ sessionId: SID, fileId: 0, fileSize: 1000, chunkSize: 300, blockIndex: 2, blockSize: 2, symbolId: 0, fileHash: sha256(new Uint8Array(1)), payloadHash: sha256(payload), payload }), RangeError);
  assert.throws(() => encodeRepairPacket({ sessionId: SID, fileId: 0, fileSize: 1000, chunkSize: 300, blockIndex: 0, blockSize: MAX_REPAIR_BLOCK + 1, symbolId: 0, fileHash: sha256(new Uint8Array(1)), payloadHash: sha256(payload), payload }), RangeError);
  assert.throws(() => encodeRepairPacket({ sessionId: SID, fileId: 0, fileSize: 1000, chunkSize: 300, blockIndex: 0, blockSize: 2, symbolId: 0, fileHash: sha256(new Uint8Array(1)), payloadHash: sha256(payload), payload: payload.subarray(1) }), RangeError);
});

async function sendFile(size: number, chunkSize: number, seed: number) {
  const data = makeBytes(size, seed);
  const p = await plan([{ name: 'f.bin', data }], chunkSize);
  return { data, p, chunks: p.files[0]!.chunkCount };
}

test('receiver: data packets lost in pass 1 are rebuilt from pass-2 repair symbols', async () => {
  // 700 chunks → 3 blocks of 234; a short last chunk exercises padding.
  const { data, p, chunks } = await sendFile(700 * 40 - 13, 40, 1);
  const rx = new ReceiverEngine({ store: new MemoryChunkStore() });
  const dropped = new Set(seededShuffle(Array.from({ length: chunks }, (_, i) => i), 3).slice(0, 105)); // 15% lost
  for (let i = 0; i < chunks; i++) if (!dropped.has(i)) await rx.ingest(await p.packet({ kind: 'data', fileId: 0, chunkIndex: i }));
  assert.equal(rx.snapshot()[0]!.files[0]!.missingChunks, 105);
  let repairsSent = 0;
  let last: IngestResult | null = null;
  for (let i = 0; i < chunks && rx.snapshot()[0]!.files[0]!.status !== 'verified'; i++) {
    last = await rx.ingest(await p.packet({ kind: 'data', fileId: 0, chunkIndex: i }, 2, true));
    repairsSent++;
  }
  const f = rx.snapshot()[0]!.files[0]!;
  assert.equal(f.status, 'verified');
  assert.equal(last?.status, 'repair');
  assert.equal(rx.stats.recoveredChunks, 105);
  // Blocks are interleaved and each gets an equal share, so completion waits for the block that lost
  // the most: blocks × (its missing + slack) symbols — far less than a whole 700-frame pass.
  const { blockSize, blockCount } = blockLayout(chunks);
  const worst = Math.max(...Array.from({ length: blockCount }, (_, b) => [...dropped].filter((i) => Math.floor(i / blockSize) === b).length));
  assert.ok(repairsSent <= blockCount * (worst + 12), `${repairsSent} repair symbols sent; worst block lost ${worst}`);
  assert.ok(repairsSent < chunks / 3);
  const got = await collect(rx.readFile(SID_HEX, 0));
  assert.ok(Buffer.from(got).equals(Buffer.from(data)));
});

test('receiver: a file can be received from repair symbols alone', async () => {
  const { data, p, chunks } = await sendFile(300 * 30, 30, 2); // 300 chunks → 2 blocks
  const rx = new ReceiverEngine({ store: new MemoryChunkStore() });
  let sent = 0;
  for (let pass = 2; pass < 6 && rx.snapshot()[0]?.files[0]?.status !== 'verified'; pass++) {
    for (let i = 0; i < chunks && rx.snapshot()[0]?.files[0]?.status !== 'verified'; i++) {
      await rx.ingest(await p.packet({ kind: 'data', fileId: 0, chunkIndex: i }, pass, true));
      sent++;
    }
  }
  assert.equal(rx.snapshot()[0]!.files[0]!.status, 'verified');
  assert.ok(sent <= chunks + 2 * 12, `${sent} symbols for ${chunks} chunks`);
  assert.ok(Buffer.from(await collect(rx.readFile(SID_HEX, 0))).equals(Buffer.from(data)));
});

test('receiver: damaged and duplicate repair symbols are refused without harm', async () => {
  const { p, chunks } = await sendFile(100 * 20, 20, 3);
  const rx = new ReceiverEngine({ store: new MemoryChunkStore() });
  for (let i = 1; i < chunks; i++) await rx.ingest(await p.packet({ kind: 'data', fileId: 0, chunkIndex: i }));
  const good = await p.repairPacket(0, 0, 5);
  const bad = good.slice();
  bad[bad.length - 1]! ^= 0xff; // payload damaged; header (and its CRC) intact
  const r1 = await rx.ingest(bad);
  assert.equal(r1.status, 'rejected');
  assert.equal(r1.status === 'rejected' && r1.reason, 'repair-hash-mismatch');
  const r2 = await rx.ingest(good);
  assert.equal(r2.status, 'repair');
  assert.equal(r2.status === 'repair' && r2.recovered, 1);
  assert.equal(rx.snapshot()[0]!.files[0]!.status, 'verified');
  assert.equal((await rx.ingest(good)).status, 'duplicate');
  assert.equal((await rx.ingest(await p.repairPacket(0, 0, 6))).status, 'duplicate'); // nothing missing any more
});

test('receiver: chunk lengths and file hash still decide — a lone repair symbol for a complete block is ignored', async () => {
  const { p, chunks } = await sendFile(10 * 50, 50, 4);
  const rx = new ReceiverEngine({ store: new MemoryChunkStore() });
  for (let i = 0; i < chunks; i++) await rx.ingest(await p.packet({ kind: 'data', fileId: 0, chunkIndex: i }));
  assert.equal(rx.snapshot()[0]!.files[0]!.status, 'verified');
  assert.equal((await rx.ingest(await p.repairPacket(0, 0, 1))).status, 'duplicate');
  assert.equal(rx.stats.recoveredChunks, 0);
  void chunkRange;
});
