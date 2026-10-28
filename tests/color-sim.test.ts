/**
 * Colour mode (three QR codes in the red, green and blue channels) vs black and
 * white, filmed through scripts/camera_sim.py's colour camera model: screen/sensor
 * crosstalk, white-balance error, Bayer sampling and 4:2:0 chroma. The receiver
 * path is the scanner's: locate (green channel) → crop → colour detection →
 * per-frame unmixing → per-channel ZXing decode, retrying a channel raw on failure.
 * The camera model is an assumption; real devices decide. Thresholds sit below measured rates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { decodeWithZxing } from '../src/qr/decoders/zxing-core.ts';
import { acceptHit } from '../src/features/receiver/scanner.ts';
import { locatorSide, regionForBox, scanRegion, targetScanSide } from '../src/features/receiver/region.ts';
import { locateQr } from '../src/qr/detect/finder.ts';
import { estimateColourMix, isColourFrame, splitChannels } from '../src/qr/color.ts';
import { encodeQr } from '../src/qr/encoder.ts';
import { frameForQr } from '../src/protocol/transport.ts';
import { maxChunkPayload, type EccLevel } from '../src/qr/capacity.ts';
import type { ScanFrame } from '../src/qr/decoders/types.ts';
import { allDataPackets, makeBytes, plan } from './helpers.ts';
import { loadZxingForTests, resizeRgb } from './frame-utils.ts';

const hasCv2 = spawnSync('python3', ['-c', 'import cv2, numpy'], { stdio: 'ignore' }).status === 0;
const N = 12;
const W = 1920, H = 1080;
const KNOBS = { crosstalk: 0.2, wb: 0.15 };

async function measure(v: number, ecc: EccLevel, layers: 1 | 3): Promise<{ codes: number; colourDetected: number; bytesPerFrame: number }> {
  const cs = maxChunkPayload(v, ecc, 'alphanumeric');
  const pkts = (await allDataPackets(await plan([{ name: 's.bin', data: makeBytes(cs * N * 3, v) }], cs))).slice(0, N * 3);
  const bits = pkts.map((p) => Array.from(encodeQr(frameForQr(p, 'alphanumeric'), { ecc, minVersion: v }).modules, (b) => (b ? '1' : '0')).join(''));
  const size = 17 + 4 * v;
  // Black-and-white frames go through the same colour camera (the code in all three channels).
  const cases = Array.from({ length: N }, (_, i) => ({ size, crop: null, layers: layers === 3 ? [bits[3 * i]!, bits[3 * i + 1]!, bits[3 * i + 2]!] : [bits[3 * i]!, bits[3 * i]!, bits[3 * i]!] }));
  const r = spawnSync('python3', ['scripts/camera_sim.py'], { input: JSON.stringify({ seed: v + 3, knobs: KNOBS, cases }), encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(r.stderr);
  let codes = 0, colourDetected = 0;
  for (const [i, line] of r.stdout.split('\n').entries()) {
    const rgb = new Uint8Array(Buffer.from(line.split(':')[0]!, 'base64'));
    const s = locatorSide(H) / H, lw = Math.round(W * s), lh = Math.round(H * s);
    const loc = locateQr({ data: resizeRgb(rgb, W, 0, 0, W, H, lw, lh), width: lw, height: lh, stride: 4 });
    const reg = loc ? regionForBox({ ...loc.box, module: loc.module }, s, W, H) : scanRegion(W, H, 0.85, targetScanSide(v));
    const frame: ScanFrame = { data: resizeRgb(rgb, W, reg.sx, reg.sy, reg.sSize, reg.sSize, reg.dSize, reg.dSize), width: reg.dSize, height: reg.dSize };
    const colour = isColourFrame(frame);
    colourDetected += +colour;
    const mix = colour ? estimateColourMix(frame) : null;
    const unmixed = mix ? splitChannels(frame, mix) : null;
    const raw = colour ? splitChannels(frame) : null;
    const tries = colour ? [0, 1, 2].map((c) => (unmixed ? [unmixed[c]!, raw![c]!] : [raw![c]!])) : [[frame]];
    const want = layers === 3 ? pkts.slice(3 * i, 3 * i + 3) : [pkts[3 * i]!];
    const seen = new Set<number>();
    for (const t of tries) for (const ch of t) {
      const hit = await decodeWithZxing(ch);
      const p = hit ? acceptHit(hit) : null;
      if (!p) continue;
      want.forEach((w, k) => { if (Buffer.from(p).equals(Buffer.from(w))) seen.add(k); });
      break;
    }
    codes += seen.size;
  }
  return { codes, colourDetected, bytesPerFrame: Math.round((cs * codes) / N) };
}

test('colour mode delivers several times more data per frame than black and white', { skip: !hasCv2 && 'python3/OpenCV not available', timeout: 900_000 }, async () => {
  await loadZxingForTests();
  const mono25 = await measure(25, 'M', 1);
  const mono40 = await measure(40, 'L', 1);
  const rgb25 = await measure(25, 'M', 3);
  const rgb30 = await measure(30, 'L', 3);
  const row = (name: string, m: Awaited<ReturnType<typeof measure>>, of: number) => `${name.padEnd(14)} ${String(m.codes).padStart(2)}/${of} codes, ${String(m.colourDetected).padStart(2)}/${N} detected as colour → ${m.bytesPerFrame} B/frame`;
  console.log(`# colour camera model (crosstalk ${KNOBS.crosstalk}, white balance ±${KNOBS.wb}), aimed:\n# ${[
    row('v25-M mono', mono25, N), row('v40-L mono', mono40, N), row('v25-M colour', rgb25, 3 * N), row('v30-L colour', rgb30, 3 * N),
  ].join('\n# ')}`);
  // Black-and-white frames are never mistaken for colour, even with a colour cast.
  assert.equal(mono25.colourDetected + mono40.colourDetected, 0);
  assert.equal(rgb25.colourDetected + rgb30.colourDetected, 2 * N);
  assert.ok(rgb25.codes >= 3 * N * 0.85, `v25-M colour: ${rgb25.codes}/${3 * N}`);
  // Colour v30-L should beat the densest black-and-white code by a wide margin.
  assert.ok(rgb30.bytesPerFrame >= 2 * mono40.bytesPerFrame, `${rgb30.bytesPerFrame} vs ${mono40.bytesPerFrame} B/frame`);
});
