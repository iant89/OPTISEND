import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameThumb, isSameFrame } from '../src/features/receiver/dedupe.ts';
import { encodeQr } from '../src/qr/encoder.ts';
import { rasterize } from './frame-utils.ts';
import { makeBytes } from './helpers.ts';

function noisy(f: { data: Uint8ClampedArray; width: number }, amp: number, seed: number): Uint8ClampedArray {
  let x = seed;
  return f.data.map((v, i) => (i % 4 === 3 ? 255 : v * 0.8 + 25 + (((x = (x * 1103515245 + 12345) & 0x7fffffff) % (2 * amp + 1)) - amp)));
}

test('duplicate frames: same code with fresh noise matches; another code or another mask does not', () => {
  const a = encodeQr({ mode: 'byte', bytes: makeBytes(200, 1) }, { ecc: 'M', minVersion: 15 });
  const b = encodeQr({ mode: 'byte', bytes: makeBytes(200, 2) }, { ecc: 'M', minVersion: 15 });
  const a2 = encodeQr({ mode: 'byte', bytes: makeBytes(200, 1) }, { ecc: 'M', minVersion: 15, maskOffset: 3 }); // same packet, next pass
  const fa = rasterize(a, 6), fb = rasterize(b, 6), fa2 = rasterize(a2, 6);
  const side = fa.width;
  const t1 = frameThumb(noisy(fa, 12, 1), side), t2 = frameThumb(noisy(fa, 12, 2), side);
  assert.ok(isSameFrame(t1, t2), 'same code, different sensor noise');
  assert.equal(isSameFrame(t1, frameThumb(noisy(fb, 12, 3), side)), false, 'different code');
  assert.equal(isSameFrame(t1, frameThumb(noisy(fa2, 12, 4), side)), false, 'same packet with the next pass\'s mask');
  assert.equal(isSameFrame(t1, frameThumb(new Uint8ClampedArray(side * side * 4).fill(255), side)), false, 'blank frame');
  assert.equal(isSameFrame(t1, frameThumb(noisy(fa, 12, 1), side, 16)), false, 'different thumbnail sizes never match');
});
