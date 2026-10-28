import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, estimateTransfer, resolveQrConfig, sanitizeSettings, type SenderSettings } from '../src/features/sender/settings.ts';
import { qrLayout } from '../src/qr/render.ts';
import { encodeQr } from '../src/qr/encoder.ts';
import { prepareTransfer } from '../src/protocol/sender.ts';
import { bytesSource } from '../src/protocol/source.ts';
import { decodePacket } from '../src/protocol/packet.ts';
import { frameForQr, unframeScan } from '../src/protocol/transport.ts';
import { formatBytes, formatDuration } from '../src/utils/format.ts';
import { makeBytes } from './helpers.ts';

const files = [
  { name: 'video.mp4', size: 123_456, type: 'video/mp4' },
  { name: 'résumé.pdf', size: 7_000, type: 'application/pdf' },
  { name: 'empty', size: 0, type: '' },
];

test('estimate matches the real plan frame-for-frame across settings', async () => {
  const variants: Partial<SenderSettings>[] = [
    {},
    { preset: 'balanced', transport: 'byte' },
    { preset: 'high-throughput', manifestEvery: 0 },
    { preset: 'custom', customVersion: 12, customEcc: 'Q', customPayload: 50, manifestEvery: 7 },
    { strategy: 'round-robin', manifestEvery: 1 },
  ];
  for (const v of variants) {
    const s = { ...DEFAULT_SETTINGS, ...v };
    const cfg = resolveQrConfig(s);
    const plan = await prepareTransfer(
      files.map((f, i) => ({ name: f.name, mimeType: f.type, source: bytesSource(makeBytes(f.size, i + 1)) })),
      { chunkSize: cfg.chunkSize, maxManifestPacketBytes: cfg.maxPacketBytes },
    );
    const est = estimateTransfer(files, s);
    const refs = [...plan.pass({ strategy: s.strategy, manifestEvery: s.manifestEvery })];
    assert.equal(est.framesPerPass, refs.length, JSON.stringify(v));
    assert.equal(est.manifestParts, plan.manifestPackets.length);
    assert.equal(est.chunkSize, cfg.chunkSize);
    const manifestFrames = refs.filter((r) => r.kind === 'manifest').length;
    assert.equal(est.passMs, (refs.length + (s.holdManifest ? manifestFrames : 0)) * s.intervalMs);
  }
});

test('every frame of a plan fits the configured QR version; data frames use exactly that version', async () => {
  for (const preset of ['conservative', 'balanced', 'high-throughput'] as const) {
    for (const transport of ['byte', 'alphanumeric'] as const) {
      const s = { ...DEFAULT_SETTINGS, preset, transport };
      const cfg = resolveQrConfig(s);
      const plan = await prepareTransfer([{ name: 'f.bin', source: bytesSource(makeBytes(cfg.chunkSize * 2 + 5)) }], { chunkSize: cfg.chunkSize, maxManifestPacketBytes: cfg.maxPacketBytes });
      for (const ref of plan.pass()) {
        const pkt = await plan.packet(ref);
        const m = encodeQr(frameForQr(pkt, cfg.transport), { ecc: cfg.ecc, minVersion: cfg.version });
        if (ref.kind === 'data') assert.equal(m.version, cfg.version, `${preset}/${transport}`);
        const back = unframeScan(cfg.transport === 'byte' ? { bytes: pkt } : { text: (frameForQr(pkt, 'alphanumeric') as { text: string }).text });
        assert.ok(back);
        decodePacket(back);
      }
    }
  }
});

test('estimate flags QR configs too small for a data packet', () => {
  const e = estimateTransfer(files, { ...DEFAULT_SETTINGS, preset: 'custom', customVersion: 3, customEcc: 'H' });
  assert.equal(e.valid, false);
  assert.match(e.problem!, /too small/);
  assert.equal(estimateTransfer([], DEFAULT_SETTINGS).valid, false);
  assert.equal(estimateTransfer(files, { ...DEFAULT_SETTINGS, passes: 3 }).totalMs, estimateTransfer(files, DEFAULT_SETTINGS).passMs * 3);
});

test('custom payload limit is capped at symbol capacity', () => {
  const big = resolveQrConfig({ ...DEFAULT_SETTINGS, preset: 'custom', customVersion: 10, customEcc: 'M', customPayload: 4000, transport: 'byte' });
  assert.equal(big.chunkSize, 213 - 116);
  const small = resolveQrConfig({ ...DEFAULT_SETTINGS, preset: 'custom', customVersion: 10, customEcc: 'M', customPayload: 40, transport: 'byte' });
  assert.equal(small.chunkSize, 40);
});

test('persisted settings are sanitised field by field', () => {
  assert.deepEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(sanitizeSettings('junk'), { ...DEFAULT_SETTINGS });
  const s = sanitizeSettings({ preset: 'balanced', intervalMs: 1000, passes: 'continuous', customVersion: 99, transport: 'evil', holdManifest: 'yes', manifestEvery: -1 });
  assert.equal(s.preset, 'balanced');
  assert.equal(s.intervalMs, 1000);
  assert.equal(s.passes, 'continuous');
  assert.equal(s.customVersion, DEFAULT_SETTINGS.customVersion);
  assert.equal(s.transport, DEFAULT_SETTINGS.transport);
  assert.equal(s.holdManifest, DEFAULT_SETTINGS.holdManifest);
  assert.equal(s.manifestEvery, DEFAULT_SETTINGS.manifestEvery);
});

test('QR layout: integer device pixels per module, quiet zone included, never larger than available', () => {
  const l = qrLayout(77, 500, 2); // v15 on a 500 css px box at 2x
  assert.equal(l.modulePx, Math.floor(1000 / 85));
  assert.equal(l.canvasPx, l.modulePx * 85);
  assert.ok(l.cssPx <= 500);
  assert.equal(l.cssPx * 2, l.canvasPx);
  assert.equal(l.tooSmall, false);
  const tiny = qrLayout(177, 100, 1);
  assert.equal(tiny.tooSmall, true);
  assert.equal(tiny.modulePx, 1);
  assert.equal(qrLayout(21, 290, 1.5).modulePx, Math.floor(435 / 29));
  assert.equal(qrLayout(21, 290, Number.NaN).modulePx, 10);
});

test('formatting helpers', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.00 GB');
  assert.equal(formatDuration(59_400), '59s');
  assert.equal(formatDuration(61_000), '1m 01s');
  assert.equal(formatDuration(3_660_000), '1h 01m');
});
