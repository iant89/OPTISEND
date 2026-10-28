/** Per-file transfer timing: first captured chunk → verified, counting only active scanning time. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryChunkStore } from '../src/protocol/chunk-store.ts';
import { ReceiverEngine } from '../src/protocol/receiver.ts';
import { allDataPackets, makeBytes, plan } from './helpers.ts';

function clockedEngine(store = new MemoryChunkStore()) {
  const clock = { t: 1_000_000 };
  const engine = new ReceiverEngine({ store, now: () => clock.t });
  return { clock, engine };
}
const file = (e: ReceiverEngine, id = 0) => e.snapshot()[0]!.files.find((f) => f.fileId === id)!;

test('clock starts at the first captured chunk and stops at verification', async () => {
  const p = await plan([{ name: 'a.bin', data: makeBytes(1000, 1) }]); // 10 chunks
  const { clock, engine } = clockedEngine();
  await engine.ingest(p.manifestPackets[0]!); // the manifest does not start the clock
  clock.t += 5_000;
  assert.equal(file(engine).timing.startedAt, null);
  const pk = await allDataPackets(p);
  for (const pkt of pk) {
    await engine.ingest(pkt);
    clock.t += 750;
  }
  const t = file(engine).timing;
  assert.equal(file(engine).status, 'verified');
  assert.equal(t.startedAt, 1_005_000);
  assert.equal(t.elapsedMs, 9 * 750, 'first chunk → last chunk (verification is instantaneous here)');
  assert.equal(t.verifiedAt, 1_005_000 + 9 * 750);
  assert.ok(Math.abs(t.bytesPerSecond! - 1000 / 6.75) < 1e-9);
  // Later duplicates (sender still looping) do not move the clock.
  clock.t += 60_000;
  for (const pkt of pk) await engine.ingest(pkt);
  assert.equal(file(engine).timing.elapsedMs, 9 * 750);
});

test('paused scanning is excluded from the file time', async () => {
  const p = await plan([{ name: 'b.bin', data: makeBytes(400, 2) }]); // 4 chunks
  const { clock, engine } = clockedEngine();
  const pk = await allDataPackets(p);
  await engine.ingest(pk[0]!);
  clock.t += 2_000;
  await engine.ingest(pk[1]!);
  engine.setReceiving(false); // user pauses / leaves the screen
  clock.t += 600_000; // ten minutes away
  assert.equal(file(engine).timing.elapsedMs, 2_000, 'clock frozen while paused');
  engine.setReceiving(true);
  clock.t += 1_000;
  await engine.ingest(pk[2]!);
  clock.t += 1_000;
  await engine.ingest(pk[3]!);
  const t = file(engine).timing;
  assert.equal(file(engine).status, 'verified');
  assert.equal(t.elapsedMs, 4_000);
  assert.equal(t.bytesPerSecond, 100);
});

test('live rate while receiving is stored bytes / active time', async () => {
  const p = await plan([{ name: 'c.bin', data: makeBytes(1000, 3) }]);
  const { clock, engine } = clockedEngine();
  const pk = await allDataPackets(p);
  await engine.ingest(pk[0]!);
  clock.t += 500;
  assert.equal(file(engine).timing.bytesPerSecond, null, 'under 1 s of data: no rate yet');
  await engine.ingest(pk[1]!);
  clock.t += 1_500;
  await engine.ingest(pk[2]!);
  const t = file(engine).timing;
  assert.equal(t.elapsedMs, 2_000);
  assert.equal(t.bytesPerSecond, 150); // 300 bytes in 2 s
});

test('single-capture and empty files report no speed instead of a fake one', async () => {
  const p = await plan([{ name: 'tiny', data: makeBytes(50, 4) }, { name: 'empty', data: new Uint8Array(0) }]);
  const { engine } = clockedEngine();
  for (const pkt of await allDataPackets(p)) await engine.ingest(pkt);
  for (const id of [0, 1]) {
    const f = file(engine, id);
    assert.equal(f.status, 'verified');
    assert.equal(f.timing.elapsedMs, 0);
    assert.equal(f.timing.bytesPerSecond, null);
    assert.notEqual(f.timing.verifiedAt, null);
  }
});

test('timing survives a reload; the closed-page gap is not counted', async () => {
  const p = await plan([{ name: 'd.bin', data: makeBytes(500, 5) }]); // 5 chunks
  const store = new MemoryChunkStore();
  const a = clockedEngine(store);
  const pk = await allDataPackets(p);
  await a.engine.ingest(pk[0]!);
  a.clock.t += 3_000;
  await a.engine.ingest(pk[1]!);
  const saved = structuredClone(a.engine.sessionIds().map((id) => a.engine.exportSession(id)!));

  const b = clockedEngine(store);
  b.clock.t = a.clock.t + 86_400_000; // reopened a day later
  b.engine.setReceiving(false); // as ReceiverStorage.open does
  await b.engine.restore(saved);
  assert.equal(file(b.engine).timing.elapsedMs, 3_000);
  assert.equal(file(b.engine).timing.startedAt, a.clock.t - 3_000);
  b.engine.setReceiving(true); // the receive screen starts scanning
  for (const pkt of pk.slice(2)) {
    b.clock.t += 1_000;
    await b.engine.ingest(pkt);
  }
  const t = file(b.engine).timing;
  assert.equal(file(b.engine).status, 'verified');
  assert.equal(t.elapsedMs, 6_000);
  assert.ok(Math.abs(t.bytesPerSecond! - 500 / 6) < 1e-9);

  // Verified timing is kept after another reload.
  const again = clockedEngine(store);
  again.engine.setReceiving(false);
  await again.engine.restore(structuredClone(b.engine.sessionIds().map((id) => b.engine.exportSession(id)!)));
  assert.deepEqual(file(again.engine).timing, t);
});

test('a reset file starts timing afresh; a failed verification shows no speed', async () => {
  const p = await plan([{ name: 'e.bin', data: makeBytes(300, 6) }]);
  const { clock, engine } = clockedEngine();
  const pk = await allDataPackets(p);
  await engine.ingest(pk[0]!);
  clock.t += 2_000;
  await engine.resetFile(engine.snapshot()[0]!.sessionId, 0);
  assert.equal(file(engine).timing.startedAt, null);
  assert.equal(file(engine).timing.elapsedMs, 0);
});

test('timing descriptions', async () => {
  const { describeTiming } = await import('../src/features/files/TransferSpeed.tsx');
  const base = { startedAt: 1, verifiedAt: null, elapsedMs: 0, bytesPerSecond: null };
  assert.equal(describeTiming({ status: 'receiving', timing: { ...base, startedAt: null } }), null);
  assert.equal(describeTiming({ status: 'receiving', timing: { ...base, elapsedMs: 400 } }), 'Receiving for under 1s');
  assert.equal(describeTiming({ status: 'receiving', timing: { ...base, elapsedMs: 65_000, bytesPerSecond: 1536 } }), 'Receiving for 1m 05s · 1.50 KB/s');
  assert.equal(describeTiming({ status: 'verified', timing: { ...base, verifiedAt: 2, elapsedMs: 12_000, bytesPerSecond: 350 } }), 'Received in 12s · 350 B/s');
  assert.equal(describeTiming({ status: 'verified', timing: { ...base, verifiedAt: 2 } }), 'Received instantly (under 1s)');
  assert.equal(describeTiming({ status: 'hash-mismatch', timing: { ...base, elapsedMs: 3_000 } }), 'Stopped after 3s — failed verification');
});
