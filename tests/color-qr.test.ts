import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compositeRgb } from '../src/qr/render.ts';
import { colourShare, estimateColourMix, isColourFrame, splitChannels } from '../src/qr/color.ts';
import { decodeWithZxing } from '../src/qr/decoders/zxing-core.ts';
import { acceptHit } from '../src/features/receiver/scanner.ts';
import { encodeQr, type QrMatrix } from '../src/qr/encoder.ts';
import { frameForQr } from '../src/protocol/transport.ts';
import { PAYLOAD_PRESETS, maxChunkPayload } from '../src/qr/capacity.ts';
import type { ScanFrame } from '../src/qr/decoders/types.ts';
import { allDataPackets, makeBytes, plan } from './helpers.ts';
import { loadZxingForTests, rasterize } from './frame-utils.ts';

/** Composite at `scale` px per module, as RGBA. */
function rasterRgb(codes: QrMatrix[], scale: number): ScanFrame {
  const { side, rgba } = compositeRgb(codes);
  const W = side * scale;
  const data = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const s = (Math.floor(y / scale) * side + Math.floor(x / scale)) * 4;
    data.set(rgba.subarray(s, s + 4), (y * W + x) * 4);
  }
  return { data, width: W, height: W };
}

async function threeCodes(presetId: keyof typeof PAYLOAD_PRESETS, transport: 'byte' | 'alphanumeric') {
  const preset = PAYLOAD_PRESETS[presetId];
  const cs = maxChunkPayload(preset.version, preset.ecc, transport);
  const pkts = (await allDataPackets(await plan([{ name: 'c.bin', data: makeBytes(cs * 3, preset.version) }], cs))).slice(0, 3);
  return { pkts, codes: pkts.map((p) => encodeQr(frameForQr(p, transport), { ecc: preset.ecc, minVersion: preset.version })) };
}

test('colour composite: shared function patterns are black, quiet zone white, data in each channel', async () => {
  const { codes } = await threeCodes('conservative', 'alphanumeric');
  const { side, rgba } = compositeRgb(codes);
  const px = (x: number, y: number) => Array.from(rgba.subarray((y * side + x) * 4, (y * side + x) * 4 + 3));
  assert.deepEqual(px(0, 0), [255, 255, 255]); // quiet zone
  assert.deepEqual(px(4, 4), [0, 0, 0]); // top-left finder corner
  assert.deepEqual(px(4 + 3, 4 + 3), [0, 0, 0]); // finder centre
  const n = codes[0]!.size;
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n * n; i += 97) assert.equal(rgba[((Math.floor(i / n) + 4) * side + (i % n) + 4) * 4 + c], codes[c]!.modules[i] ? 0 : 255);
  }
  assert.throws(() => compositeRgb([codes[0]!, encodeQr({ mode: 'byte', bytes: new Uint8Array(5) }, { ecc: 'M', minVersion: 1 })]));
});

test('colour detection: three-layer frames are colour, black-and-white codes are not', async () => {
  const { codes } = await threeCodes('conservative', 'alphanumeric');
  const colour = rasterRgb(codes, 2);
  assert.ok(isColourFrame(colour), `share ${colourShare(colour)}`);
  assert.ok(colourShare(rasterize(codes[0]!, 2)) === 0);
  assert.equal(isColourFrame(rasterize(codes[0]!, 2)), false);
  // A strong colour cast (white balance, screen tint) on a black-and-white code is still not colour.
  const mono = rasterize(codes[0]!, 2);
  const tinted = new Uint8ClampedArray(mono.data.length);
  for (let k = 0; k < tinted.length; k += 4) {
    tinted[k] = 20 + mono.data[k]! * 0.9; tinted[k + 1] = 35 + mono.data[k]! * 0.7; tinted[k + 2] = 10 + mono.data[k]! * 0.55; tinted[k + 3] = 255;
  }
  const t = { data: tinted, width: mono.width, height: mono.height };
  assert.equal(isColourFrame(t), false, `tinted share ${colourShare(t)}`);
});

test('each channel of a colour frame decodes to its own packet, exactly, at every preset and transport', async () => {
  await loadZxingForTests();
  for (const presetId of Object.keys(PAYLOAD_PRESETS) as (keyof typeof PAYLOAD_PRESETS)[]) {
    for (const transport of ['byte', 'alphanumeric'] as const) {
      const { pkts, codes } = await threeCodes(presetId, transport);
      const channels = splitChannels(rasterRgb(codes, 3));
      for (const c of [0, 1, 2] as const) {
        const hit = await decodeWithZxing(channels[c]);
        const got = hit ? acceptHit(hit) : null;
        assert.ok(got, `${presetId}/${transport} channel ${c} decodes`);
        assert.deepEqual([...got], [...pkts[c]!]);
      }
    }
  }
});

test('unmixing recovers codes from a strongly crosstalked capture', async () => {
  await loadZxingForTests();
  const { pkts, codes } = await threeCodes('balanced', 'alphanumeric');
  const clean = rasterRgb(codes, 3);
  // Camera = A·screen + b: own channel only 45% of each camera channel (so "own dark, others light"
  // is brighter than "own light, others dark": no threshold separates them), plus a raised black level.
  const A = [[0.45, 0.35, 0.2], [0.25, 0.45, 0.3], [0.2, 0.35, 0.45]];
  const mixed = new Uint8ClampedArray(clean.data.length);
  for (let k = 0; k < mixed.length; k += 4) {
    for (let c = 0; c < 3; c++) mixed[k + c] = 30 + A[c]![0]! * clean.data[k]! + A[c]![1]! * clean.data[k + 1]! + A[c]![2]! * clean.data[k + 2]!;
    mixed[k + 3] = 255;
  }
  const frame = { data: mixed, width: clean.width, height: clean.height };
  assert.ok(isColourFrame(frame));
  const raw = await Promise.all(splitChannels(frame).map(async (ch) => !!(await decodeWithZxing(ch))));
  assert.ok(raw.includes(false), 'raw channels are too mixed to all decode');
  const mix = estimateColourMix(frame);
  assert.ok(mix);
  const unmixed = splitChannels(frame, mix);
  for (const c of [0, 1, 2] as const) {
    const hit = await decodeWithZxing(unmixed[c]);
    const got = hit ? acceptHit(hit) : null;
    assert.ok(got, `channel ${c} decodes after unmixing`);
    assert.deepEqual([...got], [...pkts[c]!]);
  }
  // A black-and-white frame has no colour structure to fit.
  // (Compare as a boolean: a failure must not make the test runner print a large object.)
  assert.equal(estimateColourMix(rasterize(codes[0]!, 2)) === null, true);
});

test('ColourSplitter: main-thread fallback splits like the worker would (unmixed, or raw when asked or when no fit)', async () => {
  const { ColourSplitter } = await import('../src/qr/colour-splitter.ts');
  const s = new ColourSplitter(false);
  assert.equal(s.usingWorker, false);
  const { codes } = await threeCodes('conservative', 'alphanumeric');
  const frame = rasterRgb(codes, 2);
  const expectRaw = splitChannels({ ...frame, data: new Uint8ClampedArray(frame.data) });
  const unmixed = await s.split({ ...frame, data: new Uint8ClampedArray(frame.data) }, true);
  assert.equal(unmixed.unmixed, true);
  const raw = await s.split({ ...frame, data: new Uint8ClampedArray(frame.data) }, false);
  assert.equal(raw.unmixed, false);
  for (const c of [0, 1, 2] as const) assert.equal(Buffer.compare(Buffer.from(raw.channels[c].data), Buffer.from(expectRaw[c].data)), 0);
  // A black-and-white frame has no colour fit: raw channels come back.
  assert.equal((await s.split(rasterize(codes[0]!, 2), true)).unmixed, false);
  s.dispose();
});
