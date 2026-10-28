/** 200 ms default, per-pass mask rotation and scan-timing jitter (status/sendrate-benchmark.md). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, INTERVAL_CHOICES, migrateLegacySettings, resolveQrConfig } from '../src/features/sender/settings.ts';
import { FrameRenderer, maskOffsetForPass } from '../src/features/sender/frames.ts';
import { TransmissionScheduler, type Clock } from '../src/features/sender/scheduler.ts';
import { nextScanGap, SCAN_JITTER } from '../src/features/receiver/scanner.ts';
import { encodeQr } from '../src/qr/encoder.ts';
import { QrEncoderClient } from '../src/workers/clients.ts';
import { unframeScan } from '../src/protocol/transport.ts';
import { readPixelPerfectQr } from '../e2e/qr-read.ts';
import { makeBytes, plan } from './helpers.ts';

test('default interval is 200 ms; old saved defaults migrate, real choices are kept', () => {
  assert.equal(DEFAULT_SETTINGS.intervalMs, 200);
  assert.ok((INTERVAL_CHOICES as readonly number[]).includes(200));
  assert.equal(migrateLegacySettings({ ...DEFAULT_SETTINGS, intervalMs: 750, preset: 'balanced' }).intervalMs, 200);
  assert.equal(migrateLegacySettings({ ...DEFAULT_SETTINGS, intervalMs: 750, preset: 'balanced' }).preset, 'balanced');
  assert.equal(migrateLegacySettings({ ...DEFAULT_SETTINGS, intervalMs: 1000 }).intervalMs, 1000);
  assert.equal(migrateLegacySettings(null).intervalMs, 200);
});

test('maskOffset rotates away from the automatic mask and matches forcing that mask', () => {
  const content = { mode: 'alphanumeric' as const, text: 'OS:' + 'ABC123'.repeat(40) };
  const auto = encodeQr(content, { ecc: 'M', minVersion: 15 });
  for (const off of [1, 3, 6, 11]) {
    const rotated = encodeQr(content, { ecc: 'M', minVersion: 15, maskOffset: off });
    assert.equal(rotated.mask, (auto.mask + off) % 8);
    assert.deepEqual([...rotated.modules], [...encodeQr(content, { ecc: 'M', minVersion: 15, mask: rotated.mask }).modules]);
  }
  assert.equal(encodeQr(content, { ecc: 'M', minVersion: 15, mask: 2, maskOffset: 3 }).mask, 2, 'an explicit mask wins');
});

test('mask offsets: pass 1 is automatic, 8 consecutive passes visit all 8 masks', () => {
  assert.equal(maskOffsetForPass(1), 0);
  assert.equal(maskOffsetForPass(2), 3);
  assert.equal(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(maskOffsetForPass)).size, 8);
  assert.equal(maskOffsetForPass(9), maskOffsetForPass(1));
});

test('the same packet renders with a different mask each pass and decodes to identical bytes', async () => {
  for (const transport of ['alphanumeric', 'byte'] as const) {
    const cfg = { ...resolveQrConfig({ ...DEFAULT_SETTINGS, transport }) };
    const p = await plan([{ name: 'm.bin', data: makeBytes(cfg.chunkSize * 2, 9) }], cfg.chunkSize);
    const r = new FrameRenderer(p, cfg, new QrEncoderClient(false));
    const ref = { kind: 'data' as const, fileId: 0, chunkIndex: 1 };
    const expected = await p.packet(ref);
    const masks = new Set<number>();
    for (let pass = 1; pass <= 8; pass++) {
      const m = await r.get(ref, pass);
      masks.add(m.mask);
      const { content } = readPixelPerfectQr(m.size, m.modules);
      const pkt = typeof content === 'string' ? unframeScan({ text: content }) : unframeScan({ bytes: content });
      assert.deepEqual([...pkt!], [...expected], `${transport} pass ${pass}`);
    }
    assert.equal(masks.size, 8, `${transport}: all masks used across 8 passes`);
    assert.ok(r.has(ref, 9), 'pass 9 reuses pass 1\'s mask (and its cached render)');
  }
});

test('scheduler look-ahead reports the pass of upcoming frames across a pass boundary', () => {
  const clock: Clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined };
  const s = new TransmissionScheduler<string>({ frames: ['m', 'a', 'b'], intervalMs: 200, passes: 'continuous', clock });
  s.start();
  s.next();
  assert.deepEqual(s.peekWithPass(3), [{ frame: 'b', pass: 1 }, { frame: 'm', pass: 2 }]);
});

test('scan gaps are jittered ±25% around the nominal period with the same mean', () => {
  let x = 7;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const nominal = 1000 / 12;
  const gaps = Array.from({ length: 20_000 }, () => nextScanGap(12, rnd));
  assert.ok(Math.min(...gaps) >= nominal * (1 - SCAN_JITTER) - 1e-9);
  assert.ok(Math.max(...gaps) <= nominal * (1 + SCAN_JITTER) + 1e-9);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(Math.abs(mean - nominal) < 0.5, `mean ${mean}`);
  assert.equal(nextScanGap(10, () => 0), 75);
  assert.equal(nextScanGap(10, () => 1), 125);
});
