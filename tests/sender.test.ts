import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesEqual } from '../src/crypto/bytes.ts';
import { PacketType } from '../src/protocol/constants.ts';
import { decodePacket, type DataPacket, type ManifestPacket } from '../src/protocol/packet.ts';
import { buildManifestPackets, prepareTransfer, SenderError, type PacketRef } from '../src/protocol/sender.ts';
import { blobSource, bytesSource, hashSource } from '../src/protocol/source.ts';
import { resolveLimits } from '../src/protocol/limits.ts';
import { makeBytes, nodeSha256, plan, SID } from './helpers.ts';

test('prepareTransfer hashes files, assigns ids and chunk counts', async () => {
  const a = makeBytes(1050, 1);
  const b = new Uint8Array(0);
  const p = await plan([{ name: 'a.bin', data: a, mimeType: 'application/octet-stream' }, { name: 'empty.txt', data: b }]);
  assert.equal(p.files.length, 2);
  assert.equal(p.files[0]!.fileId, 0);
  assert.equal(p.files[0]!.chunkCount, 11);
  assert.ok(bytesEqual(p.files[0]!.fileHash, nodeSha256(a)));
  assert.equal(p.files[1]!.chunkCount, 1);
  assert.equal(p.totalDataPackets, 12);
  assert.equal(p.totalBytes, 1050);
  assert.ok(bytesEqual(p.sessionId, SID));
});

test('data packets are self-describing and carry the right bytes', async () => {
  const a = makeBytes(1050, 1);
  const p = await plan([{ name: 'a.bin', data: a }]);
  for (let i = 0; i < 11; i++) {
    const d = decodePacket(await p.dataPacket(0, i)) as DataPacket;
    assert.equal(d.chunkIndex, i);
    assert.ok(bytesEqual(d.payload, a.subarray(i * 100, Math.min(1050, (i + 1) * 100))));
    assert.ok(bytesEqual(d.chunkHash, nodeSha256(d.payload)));
    assert.ok(bytesEqual(d.fileHash, nodeSha256(a)));
  }
  await assert.rejects(p.dataPacket(0, 11));
  await assert.rejects(p.dataPacket(5, 0));
});

test('random session ids are generated when not supplied', async () => {
  const inputs = [{ name: 'x', source: bytesSource(makeBytes(10)) }];
  const p1 = await prepareTransfer(inputs, { chunkSize: 100, maxManifestPacketBytes: 500 });
  const p2 = await prepareTransfer(inputs, { chunkSize: 100, maxManifestPacketBytes: 500 });
  assert.equal(p1.sessionId.length, 8);
  assert.ok(!bytesEqual(p1.sessionId, p2.sessionId));
});

test('sender sanitises names on the wire and keeps them within 255 bytes', async () => {
  const p = await plan([{ name: '../secret/' + 'n'.repeat(400) + '.txt', data: makeBytes(5) }]);
  const m = decodePacket(p.manifestPackets[0]!) as ManifestPacket;
  assert.ok(!m.entries[0]!.name.includes('/'));
  assert.ok(new TextEncoder().encode(m.entries[0]!.name).length <= 255);
  assert.ok(m.entries[0]!.name.endsWith('.txt'));
});

test('manifest splits into parts that each fit the packet budget', async () => {
  const files = Array.from({ length: 20 }, (_, i) => ({ name: `document-number-${i}.pdf`, data: makeBytes(i * 37, i + 1) }));
  const p = await plan(files, 100, { maxManifestPacketBytes: 300 });
  assert.ok(p.manifestPackets.length > 1);
  const ids = new Set<number>();
  for (const [i, buf] of p.manifestPackets.entries()) {
    assert.ok(buf.length <= 300, `part ${i} is ${buf.length} bytes`);
    const m = decodePacket(buf) as ManifestPacket;
    assert.equal(m.partIndex, i);
    assert.equal(m.partCount, p.manifestPackets.length);
    assert.equal(m.fileCount, 20);
    for (const e of m.entries) ids.add(e.fileId);
  }
  assert.equal(ids.size, 20);
});

test('an entry too large for the budget gets its own (oversized) part', async () => {
  const p = await plan([{ name: 'x'.repeat(250), data: makeBytes(3) }, { name: 'y', data: makeBytes(3) }], 100, { maxManifestPacketBytes: 120 });
  assert.equal(p.manifestPackets.length, 2);
  assert.ok(p.manifestPackets[0]!.length > 120);
  assert.equal(buildManifestPackets(SID, p.files, 10_000).length, 1);
});

test('pass(): manifest first, every data packet once, manifest repeated periodically', async () => {
  const p = await plan([{ name: 'a', data: makeBytes(1000) }, { name: 'b', data: makeBytes(500) }]);
  const refs = [...p.pass({ manifestEvery: 4 })];
  assert.deepEqual(refs[0], { kind: 'manifest', part: 0 });
  const data = refs.filter((r): r is Extract<PacketRef, { kind: 'data' }> => r.kind === 'data');
  assert.equal(data.length, 15);
  assert.equal(new Set(data.map((r) => `${r.fileId}:${r.chunkIndex}`)).size, 15);
  // 15 data packets with a manifest every 4: 1 + floor(14/4) = 4 manifest frames.
  assert.equal(refs.filter((r) => r.kind === 'manifest').length, 4);
  assert.equal(p.packetsPerPass({ manifestEvery: 4 }), 19);
  // Sequential: all of file 0 before file 1.
  assert.deepEqual(data.slice(0, 10).map((r) => r.fileId), Array(10).fill(0));
  assert.equal(p.packetsPerPass({ manifestEvery: 0 }), 16);
});

test('round-robin interleaves files so small files finish early', async () => {
  const p = await plan([{ name: 'big', data: makeBytes(1000) }, { name: 'small', data: makeBytes(200) }]);
  const data = [...p.pass({ strategy: 'round-robin', manifestEvery: 0 })].filter((r) => r.kind === 'data');
  assert.deepEqual(data.slice(0, 4).map((r) => (r.kind === 'data' ? `${r.fileId}:${r.chunkIndex}` : '')), ['0:0', '1:0', '0:1', '1:1']);
  assert.equal(data.length, 12);
});

test('packet(ref) resolves manifest and data references', async () => {
  const p = await plan([{ name: 'a', data: makeBytes(150) }]);
  const m = decodePacket(await p.packet({ kind: 'manifest', part: 0 }));
  assert.equal(m.type, PacketType.Manifest);
  const d = decodePacket(await p.packet({ kind: 'data', fileId: 0, chunkIndex: 1 })) as DataPacket;
  assert.equal(d.payload.length, 50);
});

test('actionable errors for bad options and limits', async () => {
  const src = bytesSource(makeBytes(1000));
  await assert.rejects(prepareTransfer([], { chunkSize: 100, maxManifestPacketBytes: 500 }), SenderError);
  await assert.rejects(prepareTransfer([{ name: 'a', source: src }], { chunkSize: 0, maxManifestPacketBytes: 500 }), SenderError);
  await assert.rejects(prepareTransfer([{ name: 'a', source: src }], { chunkSize: 100, maxManifestPacketBytes: 500, limits: resolveLimits({ maxChunkCount: 5 }) }), /needs 10 QR codes/);
  await assert.rejects(prepareTransfer([{ name: 'a', source: src }], { chunkSize: 100, maxManifestPacketBytes: 500, limits: resolveLimits({ maxFileSize: 999 }) }), SenderError);
});

test('Blob sources stream without needing the whole file in one buffer', async () => {
  const data = makeBytes(300_000, 9);
  const src = blobSource(new Blob([data as Uint8Array<ArrayBuffer>]));
  const progress: number[] = [];
  const h = await hashSource(src, { blockSize: 64 * 1024, onProgress: (n) => progress.push(n) });
  assert.ok(bytesEqual(h, nodeSha256(data)));
  assert.equal(progress.length, 5);
  assert.equal(progress.at(-1), 300_000);
  assert.ok(bytesEqual(await src.read(1000, 10), data.subarray(1000, 1010)));
});

test('hashing can be aborted', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(hashSource(bytesSource(makeBytes(10)), { signal: ac.signal }));
});
