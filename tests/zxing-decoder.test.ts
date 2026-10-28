import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeWithZxing } from '../src/qr/decoders/zxing-core.ts';
import { ZXING_WASM_SHA256 } from '../src/vendor/zxing-wasm/es/reader/index.js';
import { decoderIdsFor, type DecoderMode } from '../src/features/receiver/decoders.ts';
import { acceptHit } from '../src/features/receiver/scanner.ts';
import { encodeQr } from '../src/qr/encoder.ts';
import { frameForQr } from '../src/protocol/transport.ts';
import { PAYLOAD_PRESETS, maxChunkPayload } from '../src/qr/capacity.ts';
import { allDataPackets, makeBytes, plan } from './helpers.ts';
import { loadZxingForTests, rasterize, ZXING_WASM_PATH } from './frame-utils.ts';


test('vendored .wasm is the exact file the vendored zxing-wasm build expects', () => {
  assert.equal(createHash('sha256').update(readFileSync(ZXING_WASM_PATH)).digest('hex'), ZXING_WASM_SHA256);
});

test('ZXing reads our codes exactly — binary bytes and Base45 text — at every preset', async () => {
  await loadZxingForTests();
  for (const preset of Object.values(PAYLOAD_PRESETS)) {
    for (const transport of ['byte', 'alphanumeric'] as const) {
      const cs = maxChunkPayload(preset.version, preset.ecc, transport);
      const p = await plan([{ name: 'x.bin', data: makeBytes(cs * 2, preset.version) }], cs);
      const pkt = (await allDataPackets(p))[0]!;
      const m = encodeQr(frameForQr(pkt, transport), { ecc: preset.ecc, minVersion: preset.version });
      const hit = await decodeWithZxing(rasterize(m, 3, 20));
      assert.ok(hit, `${preset.id}/${transport} decodes`);
      assert.equal(hit.version, preset.version);
      assert.equal(hit.corners?.length, 4);
      const accepted = acceptHit(hit);
      assert.ok(accepted, `${preset.id}/${transport} accepted`);
      assert.deepEqual([...accepted], [...pkt]);
    }
  }
});

test('ZXing reports nothing for a blank frame', async () => {
  await loadZxingForTests();
  const W = 200;
  assert.equal(await decodeWithZxing({ data: new Uint8ClampedArray(W * W * 4).fill(255), width: W, height: W }), null);
});

test('decoder modes: ZXing first in Automatic; jsQR only as the fallback', () => {
  const all = { native: true, zxing: true };
  const ids = (mode: DecoderMode, has = all) => decoderIdsFor(mode, has);
  assert.deepEqual(ids('auto'), ['zxing', 'native']);
  assert.deepEqual(ids('auto', { native: false, zxing: true }), ['zxing']);
  assert.deepEqual(ids('auto', { native: true, zxing: false }), ['native', 'jsqr']);
  assert.deepEqual(ids('auto', { native: false, zxing: false }), ['jsqr']);
  assert.deepEqual(ids('zxing', { native: true, zxing: false }), ['jsqr']);
  assert.deepEqual(ids('native', { native: false, zxing: true }), ['jsqr']);
  assert.deepEqual(ids('jsqr'), ['jsqr']);
  assert.deepEqual(ids('compare'), ['zxing', 'native', 'jsqr']);
});
