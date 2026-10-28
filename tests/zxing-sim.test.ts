/**
 * ZXing-C++ vs jsQR on simulated 1080p phone-camera frames (scripts/camera_sim.py),
 * cropped exactly as the scanner does: around the located code, else the guide square.
 * Thresholds sit below measured rates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { decodeWithJsQr } from '../src/qr/decoders/jsqr-core.ts';
import { decodeWithZxing } from '../src/qr/decoders/zxing-core.ts';
import { acceptHit } from '../src/features/receiver/scanner.ts';
import { locatorSide, regionForBox, scanRegion, targetScanSide, type ScanRegion } from '../src/features/receiver/region.ts';
import { locateQr } from '../src/qr/detect/finder.ts';
import { encodeQr } from '../src/qr/encoder.ts';
import { frameForQr } from '../src/protocol/transport.ts';
import { PAYLOAD_PRESETS, maxChunkPayload, type PayloadPresetId } from '../src/qr/capacity.ts';
import type { ScanFrame, ScanHit } from '../src/qr/decoders/types.ts';
import { allDataPackets, makeBytes, plan } from './helpers.ts';
import { grayToRgba, loadZxingForTests, resizeGray } from './frame-utils.ts';

const hasCv2 = spawnSync('python3', ['-c', 'import cv2, numpy'], { stdio: 'ignore' }).status === 0;
const SAMPLES = 24;
const POSES = { aimed: {}, 'hand-held': { span: [0.3, 0.75], offset: [450, 120] } } as const;
// Minimum ZXing frames decoded (of 24), well below measured rates.
const MIN: Record<PayloadPresetId, Record<keyof typeof POSES, number>> = {
  conservative: { aimed: 22, 'hand-held': 18 },
  balanced: { aimed: 20, 'hand-held': 10 },
  'high-throughput': { aimed: 10, 'hand-held': 2 },
};

test('ZXing vs jsQR on simulated camera frames, per preset and pose', { skip: !hasCv2 && 'python3/OpenCV not available', timeout: 900_000 }, async () => {
  await loadZxingForTests();
  const rows: string[] = [];
  for (const preset of Object.values(PAYLOAD_PRESETS)) {
    const v = preset.version;
    const cs = maxChunkPayload(v, preset.ecc, 'alphanumeric');
    const pkts = (await allDataPackets(await plan([{ name: 'sim.bin', data: makeBytes(cs * SAMPLES, v) }], cs))).slice(0, SAMPLES);
    const cases = pkts.map((pkt) => {
      const m = encodeQr(frameForQr(pkt, 'alphanumeric'), { ecc: preset.ecc, minVersion: v });
      return { size: m.size, bits: Array.from(m.modules, (b) => (b ? '1' : '0')).join(''), crop: null };
    });
    for (const [pose, knobs] of Object.entries(POSES) as [keyof typeof POSES, object][]) {
      const r = spawnSync('python3', ['scripts/camera_sim.py'], { input: JSON.stringify({ seed: v + 7, knobs, cases }), encoding: 'utf8', maxBuffer: 1 << 30 });
      if (r.status !== 0) throw new Error(r.stderr);
      const s = { js: 0, zx: 0, zxGuide: 0, jsOnly: 0, jsMs: 0, zxMs: 0 };
      for (const [i, line] of r.stdout.split('\n').entries()) {
        const g = new Uint8Array(Buffer.from(line.split(':')[0]!, 'base64'));
        const W = 1920, H = 1080;
        const scale = locatorSide(H) / H;
        const lw = Math.round(W * scale), lh = Math.round(H * scale);
        const loc = locateQr({ data: resizeGray(g, W, 0, 0, W, H, lw, lh), width: lw, height: lh });
        const guide = scanRegion(W, H, 0.85, targetScanSide(v));
        const crop = (reg: ScanRegion): ScanFrame => ({ data: grayToRgba(resizeGray(g, W, reg.sx, reg.sy, reg.sSize, reg.sSize, reg.dSize, reg.dSize)), width: reg.dSize, height: reg.dSize });
        const ok = (hit: ScanHit | null) => { const p = hit ? acceptHit(hit) : null; return !!p && Buffer.from(p).equals(Buffer.from(pkts[i]!)); };
        const frame = crop(loc ? regionForBox({ ...loc.box, module: loc.module }, scale, W, H) : guide);
        let t = performance.now();
        const js = ok(decodeWithJsQr(frame));
        s.jsMs += performance.now() - t;
        t = performance.now();
        const zx = ok(await decodeWithZxing(frame));
        s.zxMs += performance.now() - t;
        s.js += +js; s.zx += +zx; s.jsOnly += +(js && !zx);
        s.zxGuide += +ok(await decodeWithZxing(crop(guide)));
      }
      const n = (k: number) => `${k}/${SAMPLES}`.padStart(5);
      rows.push(`v${v}-${preset.ecc} ${pose.padEnd(9)}  jsQR ${n(s.js)} ${(s.jsMs / SAMPLES).toFixed(0).padStart(2)} ms | ZXing ${n(s.zx)} ${(s.zxMs / SAMPLES).toFixed(0).padStart(2)} ms | ZXing on guide square ${n(s.zxGuide)} | jsQR-only reads ${s.jsOnly}`);
      assert.ok(s.zx >= MIN[preset.id][pose], rows.at(-1));
      assert.ok(s.zx >= s.js, rows.at(-1));
    }
  }
  console.log(`# ZXing vs jsQR (located crop, 1080p camera sim):\n# ${rows.join('\n# ')}`);
});
