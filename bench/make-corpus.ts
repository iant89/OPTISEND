/**
 * Builds a fixed benchmark corpus for jsQR (bench/corpus.bin):
 * simulated camera frames for v15 and v25 (the scanner's real input sizes,
 * already smoothed as the scanner does), clean frames, and frames with no
 * code (what the scanner sees while the user is still aiming).
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { encodeQr } from '../src/qr/encoder.ts';
import { frameForQr } from '../src/protocol/transport.ts';
import { maxChunkPayload } from '../src/qr/capacity.ts';
import { smoothLuma } from '../src/qr/decoders/jsqr-core.ts'; // RGBA (R=G=B) smoothed frames
import { targetScanSide } from '../src/features/receiver/region.ts';
import { allDataPackets, makeBytes, plan } from '../tests/helpers.ts';

type Frame = { tag: string; w: number; h: number; rgba: Uint8ClampedArray };
const frames: Frame[] = [];

function grayToRgba(g: Uint8Array, side: number) {
  const a = new Uint8ClampedArray(side * side * 4);
  for (let k = 0; k < side * side; k++) { a[k * 4] = a[k * 4 + 1] = a[k * 4 + 2] = g[k]!; a[k * 4 + 3] = 255; }
  return a;
}

for (const [v, ecc, n] of [[15, 'M', 24], [25, 'M', 16]] as const) {
  const cs = maxChunkPayload(v, ecc, 'alphanumeric');
  const pkts = await allDataPackets(await plan([{ name: 'b', data: makeBytes(cs * n, v + 100) }], cs));
  const matrices = pkts.slice(0, n).map((p) => encodeQr(frameForQr(p, 'alphanumeric'), { ecc, minVersion: v }));
  const cases = matrices.map((m) => ({ size: m.size, bits: Array.from(m.modules, (x) => (x ? '1' : '0')).join(''), crop: { fraction: 0.85, side: targetScanSide(v) } }));
  const r = spawnSync('python3', ['scripts/camera_sim.py'], { input: JSON.stringify({ seed: v * 7, cases }), encoding: 'utf8', maxBuffer: 1 << 29 });
  if (r.status !== 0) throw new Error(r.stderr);
  r.stdout.split('\n').forEach((line, i) => {
    const [b64, sd] = line.split(':');
    const side = Number(sd);
    const raw = { data: grayToRgba(Buffer.from(b64!, 'base64'), side), width: side, height: side };
    frames.push({ tag: `cam-v${v}-${i}`, w: side, h: side, rgba: smoothLuma(raw) });
  });
  // Clean renders (4 px/module, like a close, sharp capture).
  for (const [i, m] of matrices.slice(0, 4).entries()) {
    const sc = 4, N = m.size + 8, W = N * sc + 40;
    const a = new Uint8ClampedArray(W * W * 4).fill(255);
    for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.modules[y * m.size + x])
      for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) { const k = ((20 + (y + 4) * sc + dy) * W + 20 + (x + 4) * sc + dx) * 4; a[k] = a[k + 1] = a[k + 2] = 0; }
    frames.push({ tag: `clean-v${v}-${i}`, w: W, h: W, rgba: a });
  }
}
// No-code frames: smooth noise / gradients / text-like clutter at the v15 scan size.
for (let i = 0; i < 8; i++) {
  const side = 850;
  const a = new Uint8ClampedArray(side * side * 4);
  let x = 1234 + i;
  for (let k = 0; k < side * side; k++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const px = k % side, py = Math.floor(k / side);
    const base = 120 + 60 * Math.sin(px / (40 + i * 7)) * Math.cos(py / (55 + i * 5));
    const clutter = (Math.floor(px / 9) + Math.floor(py / 13)) % (5 + i) === 0 ? -90 : 0;
    a[k * 4] = a[k * 4 + 1] = a[k * 4 + 2] = base + clutter + ((x >> 16) % 16);
    a[k * 4 + 3] = 255;
  }
  frames.push({ tag: `nocode-${i}`, w: side, h: side, rgba: a });
}

// Serialize: [count][tagLen tag w h bytes]...
const parts: Buffer[] = [];
const head = Buffer.alloc(4); head.writeUInt32LE(frames.length); parts.push(head);
for (const f of frames) {
  const t = Buffer.from(f.tag);
  const h = Buffer.alloc(12); h.writeUInt32LE(t.length, 0); h.writeUInt32LE(f.w, 4); h.writeUInt32LE(f.h, 8);
  parts.push(h, t, Buffer.from(f.rgba.buffer, f.rgba.byteOffset, f.rgba.byteLength));
}
writeFileSync('bench/corpus.bin', Buffer.concat(parts));
console.log(`corpus: ${frames.length} frames`);
