/**
 * Write the simulator's camera (same views, 30 fps, rolling shutter, exposure
 * blend, vsync-quantized sender switches, sensor noise) as a Y4M video for
 * Chromium's fake webcam. Three passes, each seen from the simulator's next hand
 * pose (as in sim.ts); Chromium loops the file.
 * Usage: npx tsx bench/sendrate/make-video.ts <seed> <intervalMs> <out.y4m> [--rotate]
 *   --rotate: the sender rotates the QR mask each pass (as the app now does).
 */
import { openSync, writeSync, closeSync } from 'node:fs';
import { prepare } from './sim.ts';

const [seed, intervalMs, out] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]!];
const p = await prepare(seed, 40, 1280, 720, process.argv.includes('--rotate'));
const fps = 30, readout = 20, exposure = 12, sigma = 5, VSYNC = 1000 / 60;
let st = seed * 31 + intervalMs;
const rnd = () => ((st = (st * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const starts: number[] = [];
let acc = 0;
for (const d of p.durations) { starts.push(acc); acc += d * intervalMs; }
const passMs = acc;
const PASSES = p.views.length;
const sw: number[] = [];
for (let k = 0; k < PASSES; k++) for (const s of starts) sw.push(Math.ceil((k * passMs + s + rnd() * 4) / VSYNC) * VSYNC);
sw.push(PASSES * passMs);
const n = p.durations.length;
const codeAt = (t: number) => {
  let lo = 0, hi = sw.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sw[mid]! <= t) lo = mid; else hi = mid - 1; }
  return { idx: lo % n, end: sw[lo + 1]!, variant: Math.floor(lo / n) % PASSES };
};
const total = PASSES * passMs;
const frames = Math.round((total / 1000) * fps);
const fd = openSync(out, 'w');
writeSync(fd, `YUV4MPEG2 W${p.w} H${p.h} F${fps}:1 Ip A1:1 C420jpeg\n`);
const Y = new Uint8Array(p.w * p.h);
const chroma = new Uint8Array((p.w / 2) * (p.h / 2) * 2).fill(128);
for (let j = 0; j < frames; j++) {
  const tf = (j * 1000) / fps;
  for (let y = 0; y < p.h; y++) {
    const ts = (tf + (y / p.h) * readout) % total;
    const { idx, end, variant } = codeAt(ts);
    const a = p.views[variant]![idx]!;
    const off = y * p.w;
    if (ts + exposure <= end) {
      for (let x = 0; x < p.w; x++) Y[off + x] = Math.max(0, Math.min(255, a[off + x]! + (rnd() + rnd() + rnd() - 1.5) * sigma * 2));
    } else {
      const nn = codeAt(end + 0.001);
      const nx = p.views[nn.variant]![nn.idx]!;
      const wo = Math.max(0, Math.min(1, (end - ts) / exposure));
      for (let x = 0; x < p.w; x++) Y[off + x] = Math.max(0, Math.min(255, a[off + x]! * wo + nx[off + x]! * (1 - wo) + (rnd() + rnd() + rnd() - 1.5) * sigma * 2));
    }
  }
  writeSync(fd, 'FRAME\n');
  writeSync(fd, Y);
  writeSync(fd, chroma);
}
closeSync(fd);
console.log(`${frames} frames, ${PASSES} passes × ${(passMs / 1000).toFixed(1)} s`);
