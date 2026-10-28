import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateQr, BinaryImage, findFinderCenters, pickFinderTriple, lumaFromRgba } from '../src/qr/detect/finder.ts';

const locate = (data: Uint8Array, width: number, height: number) => locateQr({ data, width, height });
import { encodeQr } from '../src/qr/encoder.ts';
import { makeBytes } from './helpers.ts';

/** Render a QR matrix (with 4-module quiet zone) into a w×h grey image at `px` per module, top-left at (ox, oy), rotated by `deg` about its centre. */
function render(version: number, w: number, h: number, px: number, ox: number, oy: number, deg = 0, bg = 200): Uint8Array {
  const m = encodeQr({ mode: 'byte', bytes: makeBytes(20, version) }, { ecc: 'M', minVersion: version });
  const n = m.size;
  const img = new Uint8Array(w * h).fill(bg);
  const side = (n + 8) * px;
  const cx = ox + side / 2;
  const cy = oy + side / 2;
  const cos = Math.cos((deg * Math.PI) / 180);
  const sin = Math.sin((deg * Math.PI) / 180);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Inverse-rotate into code space.
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = (cos * dx + sin * dy + side / 2) / px - 4;
      const v = (-sin * dx + cos * dy + side / 2) / px - 4;
      if (u < -4 || v < -4 || u >= n + 4 || v >= n + 4) continue;
      const mx = Math.floor(u);
      const my = Math.floor(v);
      const dark = mx >= 0 && my >= 0 && mx < n && my < n && m.modules[my * n + mx] === 1;
      img[y * w + x] = dark ? 30 : 235;
    }
  }
  return img;
}

function noise(img: Uint8Array, amp: number, seed = 3): Uint8Array {
  let x = seed;
  return img.map((v) => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return Math.max(0, Math.min(255, v + ((x % (2 * amp + 1)) - amp)));
  });
}

test('locates an axis-aligned code and estimates its size', () => {
  const W = 640, H = 480;
  for (const [version, px, ox, oy] of [[2, 6, 40, 30], [10, 4, 300, 100], [15, 3, 100, 120], [25, 3, 150, 40]] as const) {
    const loc = locate(render(version, W, H, px, ox, oy), W, H);
    assert.ok(loc, `v${version} not found`);
    const dim = 17 + 4 * version;
    assert.ok(Math.abs(loc.dimension - dim) <= 2, `v${version}: dimension ${loc.dimension} vs ${dim}`);
    assert.ok(Math.abs(loc.module - px) < 0.6, `v${version}: module ${loc.module} vs ${px}`);
    // Box covers the whole code (excluding quiet zone) and is not much bigger than code + quiet zone.
    const x0 = ox + 4 * px, y0 = oy + 4 * px, s = dim * px;
    const b = loc.box;
    assert.ok(b.x <= x0 && b.y <= y0 && b.x + b.w >= x0 + s && b.y + b.h >= y0 + s, `v${version}: box ${JSON.stringify(b)} misses code`);
    assert.ok(b.w < (dim + 8) * px * 1.5, `v${version}: box too large (${b.w})`);
  }
});

test('locates rotated codes', () => {
  const W = 640, H = 640;
  for (const deg of [-30, -8, 12, 45, 90, 170]) {
    const loc = locate(render(8, W, H, 4, 150, 150, deg), W, H);
    assert.ok(loc, `${deg}° not found`);
    const cx = loc.box.x + loc.box.w / 2;
    const cy = loc.box.y + loc.box.h / 2;
    const c = 150 + ((49 + 8) * 4) / 2;
    assert.ok(Math.abs(cx - c) < 12 && Math.abs(cy - c) < 12, `${deg}°: centre (${cx}, ${cy}) vs ${c}`);
  }
});

test('survives noise and a dim, low-contrast capture', () => {
  const W = 640, H = 480;
  const img = render(12, W, H, 4, 120, 60).map((v) => 70 + v * 0.45);
  assert.ok(locate(noise(Uint8Array.from(img), 14), W, H));
});

test('reports nothing for empty, noisy or textured frames', () => {
  const W = 640, H = 480;
  assert.equal(locate(new Uint8Array(W * H).fill(128), W, H), null);
  assert.equal(locate(noise(new Uint8Array(W * H).fill(128), 40), W, H), null);
  // Stripes and a checkerboard: periodic, but never three finder-shaped squares.
  const stripes = new Uint8Array(W * H).map((_, i) => ((i % W) >> 2) & 1 ? 30 : 230);
  assert.equal(locate(stripes, W, H), null);
  const checker = new Uint8Array(W * H).map((_, i) => (((i % W) >> 3) ^ (Math.floor(i / W) >> 3)) & 1 ? 30 : 230);
  assert.equal(locate(checker, W, H), null);
});

test('two finders are not a code; a lone finder triple at the wrong angle is rejected', () => {
  const W = 400, H = 400;
  const img = render(5, W, H, 5, 40, 40);
  // Paint over the bottom-left finder (and its separator).
  for (let y = 40 + 5 * (4 + 37 - 8); y < 40 + 5 * (4 + 37); y++) for (let x = 40 + 20; x < 40 + 20 + 8 * 5; x++) img[y * W + x] = 235;
  assert.equal(locate(img, W, H), null);
  const f = (x: number, y: number, module = 4) => ({ x, y, module, hits: 3 });
  assert.equal(pickFinderTriple([f(0, 0), f(100, 0), f(200, 0)]), null); // collinear
  assert.equal(pickFinderTriple([f(0, 0), f(100, 0), f(0, 100, 9)]), null); // mismatched module size
  assert.ok(pickFinderTriple([f(0, 0), f(100, 0), f(0, 100)]));
});

test('helpers: luma and binarisation', () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
  assert.deepEqual(Array.from(lumaFromRgba(rgba, 3, 1)), [255, 0, 76]);
  const W = 64, H = 64;
  const img = new Uint8Array(W * H).fill(200);
  img[32 * W + 32] = 20;
  const bin = new BinaryImage({ data: img, width: W, height: H }, 8);
  let dark = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dark += bin.get(x, y);
  assert.equal(bin.get(32, 32), 1);
  assert.equal(dark, 1);
  assert.deepEqual(findFinderCenters(bin), []);
  // RGBA input reads the green channel.
  const frame = new Uint8ClampedArray(W * H * 4).fill(200);
  frame[(32 * W + 32) * 4 + 1] = 20;
  assert.equal(new BinaryImage({ data: frame, width: W, height: H, stride: 4 }, 8).get(32, 32), 1);
});
