/**
 * Locate-then-crop vs the fixed guide crop, on simulated 1080p phone-camera
 * frames (scripts/camera_sim.py). Both pipelines see the same frames and use
 * jsQR; "aimed" is the camera-sim pose (code near the centre), "hand-held"
 * varies distance and aim. Blank frames (a busy non-QR screen) measure the
 * locator's false positives. Thresholds sit below measured rates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { decodeWithJsQr } from '../src/qr/decoders/jsqr-core.ts';
import { acceptHit } from '../src/features/receiver/scanner.ts';
import { locatorSide, regionForBox, scanRegion, targetScanSide, type ScanRegion } from '../src/features/receiver/region.ts';
import { locateQr } from '../src/qr/detect/finder.ts';
import { encodeQr } from '../src/qr/encoder.ts';
import { frameForQr } from '../src/protocol/transport.ts';
import { PAYLOAD_PRESETS, maxChunkPayload } from '../src/qr/capacity.ts';
import { allDataPackets, makeBytes, plan } from './helpers.ts';
import { grayToRgba, resizeGray } from './frame-utils.ts';

const hasCv2 = spawnSync('python3', ['-c', 'import cv2, numpy'], { stdio: 'ignore' }).status === 0;
const SAMPLES = 24;
const POSES = {
  aimed: {},
  'hand-held': { span: [0.3, 0.75], offset: [450, 120] },
} as const;

function film(cases: object[], seed: number, knobs: object): { gray: Uint8Array; w: number; h: number }[] {
  const r = spawnSync('python3', ['scripts/camera_sim.py'], { input: JSON.stringify({ seed, knobs, cases }), encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.split('\n').map((line) => {
    const [b64, dims] = line.split(':');
    const [w, h] = dims!.split('x').map(Number);
    return { gray: new Uint8Array(Buffer.from(b64!, 'base64')), w: w!, h: h! };
  });
}

function decodeRegion(f: { gray: Uint8Array; w: number }, r: ScanRegion): { pkt: Uint8Array | null; ms: number } {
  const crop = resizeGray(f.gray, f.w, r.sx, r.sy, r.sSize, r.sSize, r.dSize, r.dSize);
  const t0 = performance.now();
  const hit = decodeWithJsQr({ data: grayToRgba(crop), width: r.dSize, height: r.dSize });
  return { pkt: hit ? acceptHit(hit) : null, ms: performance.now() - t0 };
}

/** The new path: downscale the whole frame to half size, locate, crop around the code. Times the locator on RGBA (the canvas downscale is GPU work in the browser). */
function locate(f: { gray: Uint8Array; w: number; h: number }) {
  const side = locatorSide(Math.min(f.w, f.h));
  const scale = side / Math.min(f.w, f.h);
  const lw = Math.round(f.w * scale);
  const lh = Math.round(f.h * scale);
  const rgba = grayToRgba(resizeGray(f.gray, f.w, 0, 0, f.w, f.h, lw, lh));
  const t0 = performance.now();
  const loc = locateQr({ data: rgba, width: lw, height: lh, stride: 4 });
  const ms = performance.now() - t0;
  return { region: loc ? regionForBox({ ...loc.box, module: loc.module }, scale, f.w, f.h) : null, ms };
}

const same = (a: Uint8Array | null, b: Uint8Array) => !!a && Buffer.from(a).equals(Buffer.from(b));

test('locate-then-crop vs fixed guide crop on simulated camera frames', { skip: !hasCv2 && 'python3/OpenCV not available', timeout: 600_000 }, async () => {
  const rows: string[] = [];
  for (const preset of [PAYLOAD_PRESETS.conservative, PAYLOAD_PRESETS.balanced]) {
    const cs = maxChunkPayload(preset.version, preset.ecc, 'alphanumeric');
    const pkts = (await allDataPackets(await plan([{ name: 'sim.bin', data: makeBytes(cs * SAMPLES, preset.version) }], cs))).slice(0, SAMPLES);
    const cases = pkts.map((pkt) => {
      const m = encodeQr(frameForQr(pkt, 'alphanumeric'), { ecc: preset.ecc, minVersion: preset.version });
      return { size: m.size, bits: Array.from(m.modules, (v) => (v ? '1' : '0')).join(''), crop: null };
    });
    for (const [pose, knobs] of Object.entries(POSES)) {
      const frames = film(cases, preset.version, knobs);
      const s = { guide: 0, found: 0, tight: 0, either: 0, guideMs: 0, locMs: 0, tightMs: 0 };
      frames.forEach((f, i) => {
        const g = decodeRegion(f, scanRegion(f.w, f.h, 0.85, targetScanSide(preset.version)));
        const guideOk = same(g.pkt, pkts[i]!);
        s.guide += +guideOk; s.guideMs += g.ms;
        const l = locate(f);
        s.locMs += l.ms;
        if (!l.region) return;
        s.found++;
        const d = decodeRegion(f, l.region);
        const tightOk = same(d.pkt, pkts[i]!);
        s.tight += +tightOk; s.tightMs += d.ms;
        // The scanner alternates crops after a miss; jsQR's failures on different crops are largely independent.
        s.either += +(tightOk || guideOk);
      });
      const n = (k: number) => `${k}/${SAMPLES}`.padStart(5);
      const ms = (t: number, k = SAMPLES) => `${(t / Math.max(1, k)).toFixed(0).padStart(3)} ms`;
      rows.push(`v${preset.version} ${pose.padEnd(9)}  guide ${n(s.guide)} ${ms(s.guideMs)} | locate ${(s.locMs / SAMPLES).toFixed(1)} ms, found ${n(s.found)} | tight crop ${n(s.tight)} ${ms(s.tightMs, s.found)} | tight, then guide ${n(s.either)}`);
      if (pose === 'aimed') assert.ok(s.found >= SAMPLES * 0.85, rows.at(-1));
      assert.ok(s.either >= s.guide, rows.at(-1));
      if (pose === 'hand-held') assert.ok(s.tight > s.guide, rows.at(-1));
    }
  }

  const blanks = film(Array.from({ length: SAMPLES }, () => ({ blank: true, crop: null })), 99, POSES['hand-held']);
  const falsePos = blanks.filter((f) => locate(f).region).length;
  rows.push(`blank screens: locator false positives ${falsePos}/${SAMPLES}`);
  console.log(`# locator vs guide crop (jsQR, 1080p camera sim):\n# ${rows.join('\n# ')}`);
  assert.equal(falsePos, 0);
});
