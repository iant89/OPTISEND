/**
 * The vendored jsQR is performance-modified. These tests prove it returns
 * exactly what upstream returns (data, bytes, version, and corner/finder
 * locations) across code sizes, odd image dimensions, noise, distortion,
 * no-code frames and every inversion mode — and that it is faster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { encodeQr } from '../src/qr/encoder.ts';
import { makeBytes } from './helpers.ts';

const require = createRequire(import.meta.url);
const upstream = require('./fixtures/jsQR.upstream.cjs');
const modified = require('../src/vendor/jsqr/jsQR.cjs');

type Opt = { inversionAttempts: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' };

/** Call a decoder, turning an exception into a comparable marker. */
function attempt(fn: () => unknown) {
  try {
    return summary(fn());
  } catch {
    return 'threw';
  }
}

function summary(r: any) {
  if (!r) return null;
  return { data: r.data, bytes: Buffer.from(r.binaryData).toString('hex'), version: r.version, chunks: r.chunks.length, loc: r.location };
}

/** Deterministic test images: rendered codes with distortion/noise, odd sizes, inverted, and clutter. */
function* images(): Generator<{ tag: string; w: number; h: number; rgba: Uint8ClampedArray; gray: boolean }> {
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const v of [2, 5, 10, 15, 25]) {
    for (const variant of ['clean', 'skew-noise', 'inverted', 'odd-size']) {
      const m = encodeQr({ mode: 'byte', bytes: makeBytes(Math.floor(v * v * 0.8) + 5, v) }, { ecc: 'M', minVersion: v });
      const scale = 3 + (v < 10 ? 2 : 0);
      const N = m.size + 8;
      const w = N * scale + (variant === 'odd-size' ? 37 : 16);
      const h = N * scale + (variant === 'odd-size' ? 13 : 16);
      const rgba = new Uint8ClampedArray(w * h * 4);
      const skew = variant === 'skew-noise' ? 0.08 : 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // Inverse map with a small shear for the distorted variant.
          const sx = (x - 8 - skew * (y - h / 2)) / scale - 4;
          const sy = (y - 8) / scale - 4;
          const mx = Math.floor(sx), my = Math.floor(sy);
          let dark = mx >= 0 && my >= 0 && mx < m.size && my < m.size && m.modules[my * m.size + mx] === 1;
          if (variant === 'inverted') dark = !dark;
          let lum = dark ? 30 : 220;
          if (variant === 'skew-noise') lum += (rnd() - 0.5) * 60;
          const k = (y * w + x) * 4;
          // Colour tint so the RGBA path exercises the real weighting.
          rgba[k] = lum + 10; rgba[k + 1] = lum; rgba[k + 2] = lum - 10; rgba[k + 3] = 255;
        }
      }
      yield { tag: `v${v}-${variant}`, w, h, rgba, gray: false };
    }
  }
  for (let i = 0; i < 4; i++) {
    const w = 301 + i * 97, h = 257 + i * 61;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let k = 0; k < w * h; k++) {
      const x = k % w, y = Math.floor(k / w);
      const lum = 128 + 80 * Math.sin(x / (7 + i)) * Math.cos(y / (11 + i)) + (rnd() - 0.5) * 40;
      rgba[k * 4] = rgba[k * 4 + 1] = rgba[k * 4 + 2] = lum; rgba[k * 4 + 3] = 255;
    }
    yield { tag: `clutter-${i}`, w, h, rgba, gray: true };
  }
}

test('vendored upstream fixture is the pristine release', () => {
  const hash = createHash('sha256').update(readFileSync(new URL('./fixtures/jsQR.upstream.cjs', import.meta.url))).digest('hex');
  assert.equal(hash, '3325b0888fa4745c4e6940897d8c4f426fbaae76901fcbfe1871a04e90a51655');
});

test('modified jsQR returns identical results to upstream for every image and inversion mode', () => {
  const modes: Opt['inversionAttempts'][] = ['dontInvert', 'onlyInvert', 'attemptBoth', 'invertFirst'];
  let decoded = 0;
  let compared = 0;
  for (const img of images()) {
    for (const mode of modes) {
      // Upstream throws for "onlyInvert" (it never builds the inverted image); the modified
      // jsQR() keeps that behaviour exactly, so "both threw" counts as identical.
      const a = attempt(() => upstream(img.rgba, img.w, img.h, { inversionAttempts: mode }));
      const b = attempt(() => modified(img.rgba, img.w, img.h, { inversionAttempts: mode }));
      assert.deepEqual(b, a, `${img.tag} / ${mode}`);
      compared++;
      if (a && a !== 'threw') decoded++;
    }
  }
  assert.ok(decoded >= 30, `only ${decoded} decodes — corpus too weak to be meaningful`);
  console.log(`# ${compared} comparisons, ${decoded} with a decoded code — all identical`);
});

test('luminance entry point matches the RGBA path for grey images (all inversion modes)', () => {
  for (const img of images()) {
    // Build a true grey image (R=G=B) and its luminance plane.
    const n = img.w * img.h;
    const plane = new Uint8ClampedArray(n);
    const grey = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      plane[i] = img.rgba[i * 4 + 1]!;
      grey[i * 4] = grey[i * 4 + 1] = grey[i * 4 + 2] = plane[i]!; grey[i * 4 + 3] = 255;
    }
    for (const mode of ['dontInvert', 'attemptBoth', 'invertFirst'] as const) {
      assert.deepEqual(summary(modified.luminance(plane, img.w, img.h, { inversionAttempts: mode })), summary(upstream(grey, img.w, img.h, { inversionAttempts: mode })), `${img.tag} / ${mode}`);
    }
    // "onlyInvert" (broken upstream) works in the luminance path and equals invertFirst's inverted pass.
    const only = summary(modified.luminance(plane, img.w, img.h, { inversionAttempts: 'onlyInvert' }));
    if (img.tag.endsWith('-inverted')) assert.ok(only, `${img.tag}: onlyInvert should decode an inverted code`);
  }
  assert.throws(() => modified.luminance(new Uint8ClampedArray(10), 4, 4));
});

test('modified jsQR is substantially faster', () => {
  const imgs = [...images()].filter((i) => i.tag.startsWith('v15') || i.tag.startsWith('v25') || i.tag.startsWith('clutter'));
  const time = (fn: (i: (typeof imgs)[number]) => unknown) => {
    for (const i of imgs) fn(i); // warm up
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t = performance.now();
      for (const i of imgs) fn(i);
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  const up = time((i) => upstream(i.rgba, i.w, i.h, { inversionAttempts: 'dontInvert' }));
  const mod = time((i) => modified(i.rgba, i.w, i.h, { inversionAttempts: 'dontInvert' }));
  console.log(`# upstream ${up.toFixed(1)} ms, modified ${mod.toFixed(1)} ms (${(up / mod).toFixed(2)}× faster)`);
  assert.ok(mod < up * 0.75, `expected ≥1.33× speed-up, got ${(up / mod).toFixed(2)}×`);
});
