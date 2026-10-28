/**
 * End-to-end optical path: file → packets → real QR images (OpenCV) with blur
 * and noise → QR decode → unframe → receiver → verified bytes.
 * Skipped automatically when python3 + OpenCV are unavailable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { bytesEqual } from '../src/crypto/bytes.ts';
import { MemoryChunkStore } from '../src/protocol/chunk-store.ts';
import { ReceiverEngine } from '../src/protocol/receiver.ts';
import { prepareTransfer } from '../src/protocol/sender.ts';
import { bytesSource } from '../src/protocol/source.ts';
import { frameForQr, unframeScan } from '../src/protocol/transport.ts';
import { maxChunkPayload, maxPacketBytes, smallestVersionFor } from '../src/qr/capacity.ts';
import { collect, makeBytes } from './helpers.ts';

const hasCv2 = spawnSync('python3', ['-c', 'import cv2, numpy'], { stdio: 'ignore' }).status === 0;

function optical(version: number, ecc: string, frames: string[], seed: number): (string | null)[] {
  const r = spawnSync('python3', ['scripts/qr_roundtrip.py'], { input: JSON.stringify({ version, ecc, frames, seed }), maxBuffer: 64 << 20, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as (string | null)[];
}

test('two files survive a real QR encode → noisy image → decode round trip', { skip: !hasCv2 && 'python3/OpenCV not available' }, async () => {
  const version = 10;
  const ecc = 'M' as const;
  const chunkSize = maxChunkPayload(version, ecc, 'alphanumeric');
  assert.ok(chunkSize > 50);
  const a = makeBytes(2500, 1);
  const b = makeBytes(777, 2);
  const plan = await prepareTransfer(
    [{ name: 'notes.txt', mimeType: 'text/plain', source: bytesSource(a) }, { name: 'notes.txt', source: bytesSource(b) }],
    { chunkSize, maxManifestPacketBytes: maxPacketBytes(version, ecc, 'alphanumeric') },
  );

  // One pass, but simulate the receiver missing every 4th frame.
  const refs = [...plan.pass({ manifestEvery: 10 })];
  const frames: string[] = [];
  for (const ref of refs) {
    const pkt = await plan.packet(ref);
    const v = smallestVersionFor(pkt.length, ecc, 'alphanumeric');
    assert.ok(v !== null && v <= version, 'every frame fits the configured version (rendered at that fixed version)');
    const f = frameForQr(pkt, 'alphanumeric');
    frames.push(f.mode === 'alphanumeric' ? f.text : '');
  }
  // Each pass is an independent "capture" with its own noise.
  const pass1 = optical(version, ecc, frames, 1);
  const pass2 = optical(version, ecc, frames, 2);
  assert.ok(pass1.filter((d) => d !== null).length >= pass1.length * 0.9, 'most frames decode');

  const rx = new ReceiverEngine({ store: new MemoryChunkStore() });
  const feedPass = async (decoded: (string | null)[], skipEvery: number) => {
    for (let i = 0; i < decoded.length; i++) {
      if (skipEvery && i % skipEvery === 3) continue;
      const text = decoded[i];
      if (!text) continue;
      const pkt = unframeScan({ text });
      assert.ok(pkt, `frame ${i} unframes`);
      await rx.ingest(pkt);
    }
  };
  await feedPass(pass1, 4);
  const partial = rx.snapshot()[0]!;
  assert.ok(!partial.complete && partial.progress > 0.5 && partial.progress < 1);
  await feedPass(pass2, 0); // second pass fills the gaps
  const s = rx.snapshot()[0]!;
  assert.ok(s.complete, JSON.stringify(s.files.map((f) => [f.status, f.missingChunks])));
  assert.equal(rx.stats.rejected, 0);
  assert.ok(bytesEqual(await collect(rx.readFile(s.sessionId, 0)), a));
  assert.ok(bytesEqual(await collect(rx.readFile(s.sessionId, 1)), b));
  assert.equal(s.files[0]!.name, 'notes.txt');
  assert.equal(s.files[1]!.name, 'notes.txt');
});
