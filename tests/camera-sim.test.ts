/**
 * Decode-rate measurement: jsQR on simulated phone-camera captures of a
 * monitor with a 1080p camera (tilt, keystone, blur, brightness gradient, gamma,
 * noise, sub-pixel moiré), cropped and downscaled exactly like the browser scanner.
 * Thresholds are deliberately below measured rates; real devices decide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { decodeWithJsQr } from '../src/qr/decoders/jsqr-core.ts';
import { acceptHit } from '../src/features/receiver/scanner.ts';
import { targetScanSide } from '../src/features/receiver/region.ts';
import { encodeQr } from '../src/qr/encoder.ts';
import { frameForQr } from '../src/protocol/transport.ts';
import { PAYLOAD_PRESETS, maxChunkPayload, type PayloadPresetId } from '../src/qr/capacity.ts';
import { allDataPackets, makeBytes, plan } from './helpers.ts';

const hasCv2 = spawnSync('python3', ['-c', 'import cv2, numpy'], { stdio: 'ignore' }).status === 0;
const SAMPLES = 24;
// Per-FRAME rates. Each code is visible for ~9 scan cycles (750 ms at ~12 scans/s), so a
// 75% per-frame rate means essentially every code is captured. Balanced/High are reported,
// with low floors: they motivate the in-house decoder (see status/decisions.md).
const MIN_RATE: Record<PayloadPresetId, number> = { conservative: 0.75, balanced: 0.15, 'high-throughput': 0 };

test('jsQR decode rate on simulated camera captures, per density preset', { skip: !hasCv2 && 'python3/OpenCV not available', timeout: 240_000 }, async () => {
  const rows: string[] = [];
  for (const preset of Object.values(PAYLOAD_PRESETS)) {
    const transport = 'alphanumeric' as const;
    const cs = maxChunkPayload(preset.version, preset.ecc, transport);
    const p = await plan([{ name: 'sim.bin', data: makeBytes(cs * SAMPLES, preset.version) }], cs);
    const pkts = await allDataPackets(p);
    const cases = pkts.slice(0, SAMPLES).map((pkt) => {
      const m = encodeQr(frameForQr(pkt, transport), { ecc: preset.ecc, minVersion: preset.version });
      return { size: m.size, bits: Array.from(m.modules, (v) => (v ? '1' : '0')).join(''), crop: { fraction: 0.85, side: targetScanSide(preset.version) } };
    });
    const r = spawnSync('python3', ['scripts/camera_sim.py'], { input: JSON.stringify({ seed: preset.version, cases }), encoding: 'utf8', maxBuffer: 512 << 20 });
    if (r.status !== 0) throw new Error(r.stderr);
    let ok = 0;
    let ms = 0;
    r.stdout.split('\n').forEach((line, i) => {
      const [b64, sideStr] = line.split(':');
      const side = Number(sideStr);
      const gray = Buffer.from(b64!, 'base64');
      const rgba = new Uint8ClampedArray(side * side * 4);
      for (let k = 0; k < side * side; k++) { rgba[k * 4] = rgba[k * 4 + 1] = rgba[k * 4 + 2] = gray[k]!; rgba[k * 4 + 3] = 255; }
      const t0 = performance.now();
      const hit = decodeWithJsQr({ data: rgba, width: side, height: side });
      ms += performance.now() - t0;
      const pkt = hit ? acceptHit(hit) : null;
      if (pkt && Buffer.from(pkt).equals(Buffer.from(pkts[i]!))) ok++;
    });
    const rate = ok / SAMPLES;
    rows.push(`${preset.id.padEnd(16)} v${preset.version}-${preset.ecc}  ${ok}/${SAMPLES} decoded (${Math.round(rate * 100)}%)  avg ${(ms / SAMPLES).toFixed(0)} ms at ${targetScanSide(preset.version)}px`);
    assert.ok(rate >= MIN_RATE[preset.id], rows.at(-1) ?? "");
  }
  console.log(`# camera simulation (jsQR):\n# ${rows.join('\n# ')}`);
});
