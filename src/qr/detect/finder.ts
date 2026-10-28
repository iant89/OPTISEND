/**
 * Fast QR locator: finds the three finder patterns (the 7×7 corner squares)
 * in a greyscale image and returns where the code is, without decoding it.
 *
 * Pipeline: block-wise local-mean threshold → row scan for the 1:1:3:1:1
 * dark/light run signature → vertical, horizontal and diagonal cross-checks →
 * cluster → pick the three centres that form a QR-shaped right angle.
 * Pixels are thresholded lazily (only scanned rows and cross-checks), so the
 * cost is about one pass over half the image.
 */

export interface FinderCenter {
  x: number;
  y: number;
  /** Estimated module size in pixels. */
  module: number;
  /** Number of scan rows that confirmed this centre. */
  hits: number;
}

export interface QrLocation {
  /** Finder centres: the right-angle corner (top-left of the code), then the other two. */
  finders: [FinderCenter, FinderCenter, FinderCenter];
  /** Estimated module size in pixels (average of the three finders). */
  module: number;
  /** Estimated modules across the code (17 + 4·version), from finder spacing. */
  dimension: number;
  /** Axis-aligned box covering the whole code plus a small margin, in image pixels (clamped to the image). */
  box: { x: number; y: number; w: number; h: number };
}

/** A greyscale image, or an RGBA image read through its green channel. */
export interface GrayImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** Bytes per pixel: 1 (grey) or 4 (RGBA; the green channel stands in for luma). Default 1. */
  stride?: 1 | 4;
}

export interface LocateOptions {
  /** Scan every n-th row (default 2). */
  rowStep?: number;
}

/** Neighbourhoods whose luma range is below this are flat (no edges): all light. */
const MIN_CONTRAST = 24;

/**
 * Local-threshold view of a grey image: a pixel is dark when it is below the
 * mean of its neighbourhood by more than `bias`. The image is split into
 * square blocks (side ≈ 0.4·radius) whose statistics are sampled on every
 * other pixel; each block's threshold is the mean of the 5×5 blocks around it,
 * so the window spans ≈ 2·radius. Flat neighbourhoods are all light, so sensor
 * noise on a blank wall does not produce dark runs.
 */
export class BinaryImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly stride: number;
  readonly offset: number;
  readonly block: number;
  readonly blocksX: number;
  /** Per-block threshold; −1 for flat blocks (nothing is below it). */
  readonly thr: Float32Array;
  readonly colBlock: Uint32Array;

  constructor(img: GrayImage, radius: number, bias = 6) {
    const { width, height, data } = img;
    this.width = width;
    this.height = height;
    this.data = data;
    this.stride = img.stride ?? 1;
    this.offset = this.stride === 4 ? 1 : 0;
    const B = (this.block = Math.max(2, Math.round((radius * 2) / 5)));
    const bw = (this.blocksX = Math.ceil(width / B));
    const bh = Math.ceil(height / B);
    this.colBlock = new Uint32Array(width);
    for (let x = 0; x < width; x++) this.colBlock[x] = (x / B) | 0;

    const sum = new Uint32Array(bw * bh);
    const cnt = new Uint32Array(bw * bh);
    const lo = new Uint8Array(bw * bh).fill(255);
    const hi = new Uint8Array(bw * bh);
    const { stride, offset, colBlock } = this;
    for (let y = 0; y < height; y += 2) {
      const brow = ((y / B) | 0) * bw;
      const row = y * width;
      for (let x = 0; x < width; x += 2) {
        const v = data[(row + x) * stride + offset]!;
        const k = brow + colBlock[x]!;
        sum[k] = sum[k]! + v;
        cnt[k] = cnt[k]! + 1;
        if (v < lo[k]!) lo[k] = v;
        if (v > hi[k]!) hi[k] = v;
      }
    }
    this.thr = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let s = 0, n = 0, mn = 255, mx = 0;
        for (let yy = Math.max(0, by - 2); yy <= Math.min(bh - 1, by + 2); yy++) {
          for (let xx = Math.max(0, bx - 2); xx <= Math.min(bw - 1, bx + 2); xx++) {
            const k = yy * bw + xx;
            s += sum[k]!;
            n += cnt[k]!;
            if (lo[k]! < mn) mn = lo[k]!;
            if (hi[k]! > mx) mx = hi[k]!;
          }
        }
        this.thr[by * bw + bx] = n === 0 || mx - mn < MIN_CONTRAST ? -1 : s / n - bias;
      }
    }
  }

  /** 1 if (x, y) is dark. Coordinates must be inside the image. */
  get(x: number, y: number): number {
    return this.data[(y * this.width + x) * this.stride + this.offset]! < this.thr[((y / this.block) | 0) * this.blocksX + this.colBlock[x]!]! ? 1 : 0;
  }
}

/** Rec. 601-ish luma from RGBA, one byte per pixel. */
export function lumaFromRgba(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (data[j]! * 77 + data[j + 1]! * 150 + data[j + 2]! * 29) >> 8;
  return out;
}

/** True if five run lengths look like a finder cross-section (1:1:3:1:1, ±50% per module by default). */
function isFinderRatio(c: number[], tolerance = 0.5): boolean {
  const total = c[0]! + c[1]! + c[2]! + c[3]! + c[4]!;
  if (total < 7) return false;
  const m = total / 7;
  const v = m * tolerance;
  return Math.abs(m - c[0]!) < v && Math.abs(m - c[1]!) < v && Math.abs(3 * m - c[2]!) < 3 * v && Math.abs(m - c[3]!) < v && Math.abs(m - c[4]!) < v;
}

function centerFromEnd(c: number[], end: number): number {
  return end - c[4]! - c[3]! - c[2]! / 2;
}

/**
 * Walk both ways from (x, y) along one axis through dark-light-dark runs and
 * return the refined centre on that axis, or NaN if the cross-section is not a
 * finder of similar size to the original one.
 */
function crossCheck(bin: BinaryImage, x: number, y: number, origTotal: number, vertical: boolean): number {
  const limit = vertical ? bin.height : bin.width;
  const at = vertical ? (i: number) => bin.get(x, i) : (i: number) => bin.get(i, y);
  const start = vertical ? y : x;
  const maxRun = origTotal; // no single run can exceed the whole pattern
  const c = [0, 0, 0, 0, 0];
  let i = start;
  while (i >= 0 && at(i)) { c[2] = c[2]! + 1; i--; }
  if (i < 0) return NaN;
  while (i >= 0 && !at(i) && c[1]! <= maxRun) { c[1] = c[1]! + 1; i--; }
  if (i < 0 || c[1]! > maxRun) return NaN;
  while (i >= 0 && at(i) && c[0]! <= maxRun) { c[0] = c[0]! + 1; i--; }
  if (c[0]! > maxRun) return NaN;
  i = start + 1;
  while (i < limit && at(i)) { c[2] = c[2]! + 1; i++; }
  if (i === limit) return NaN;
  while (i < limit && !at(i) && c[3]! <= maxRun) { c[3] = c[3]! + 1; i++; }
  if (i === limit || c[3]! > maxRun) return NaN;
  while (i < limit && at(i) && c[4]! <= maxRun) { c[4] = c[4]! + 1; i++; }
  if (c[4]! > maxRun) return NaN;
  const total = c[0]! + c[1]! + c[2]! + c[3]! + c[4]!;
  // Perspective and rotation stretch one axis: allow ±40% of the original size.
  if (5 * Math.abs(total - origTotal) >= 2 * origTotal) return NaN;
  // Blur thins the light ring after thresholding, so confirmations are more lenient than the row scan.
  return isFinderRatio(c, 0.7) ? centerFromEnd(c, i) : NaN;
}

/**
 * Diagonal sanity check through (x, y): the same dark-light-dark-light-dark
 * structure must appear along the up-left/down-right diagonal. Rejects
 * crosses formed by lines and stripes, which pass the two axis checks.
 */
function diagonalCheck(bin: BinaryImage, x: number, y: number): boolean {
  const c = [0, 0, 0, 0, 0];
  const inside = (i: number) => x + i >= 0 && y + i >= 0 && x + i < bin.width && y + i < bin.height;
  const at = (i: number) => bin.get(x + i, y + i);
  let i = 0;
  while (inside(i) && at(i)) { c[2] = c[2]! + 1; i--; }
  while (inside(i) && !at(i)) { c[1] = c[1]! + 1; i--; }
  while (inside(i) && at(i)) { c[0] = c[0]! + 1; i--; }
  i = 1;
  while (inside(i) && at(i)) { c[2] = c[2]! + 1; i++; }
  while (inside(i) && !at(i)) { c[3] = c[3]! + 1; i++; }
  while (inside(i) && at(i)) { c[4] = c[4]! + 1; i++; }
  return c.every((n) => n > 0) && isFinderRatio(c, 0.75);
}

/** Finders smaller than this (pixels per module) are indistinguishable from sensor noise. */
export const MIN_MODULE_PX = 1.75;

/** All finder-pattern centres in a binary image. */
export function findFinderCenters(bin: BinaryImage, rowStep = 2): FinderCenter[] {
  const { width, height, data, stride, offset, thr, colBlock, block, blocksX } = bin;
  const centers: FinderCenter[] = [];
  const c = [0, 0, 0, 0, 0];
  const consider = (row: number, end: number) => {
    const total = c[0]! + c[1]! + c[2]! + c[3]! + c[4]!;
    const cx0 = Math.floor(centerFromEnd(c, end));
    const cy = crossCheck(bin, cx0, row, total, true);
    if (Number.isNaN(cy)) return false;
    const cx = crossCheck(bin, cx0, Math.floor(cy), total, false);
    if (Number.isNaN(cx)) return false;
    const module = total / 7;
    if (module < MIN_MODULE_PX || !diagonalCheck(bin, Math.floor(cx), Math.floor(cy))) return false;
    for (const p of centers) {
      if (Math.abs(p.x - cx) <= module * 1.5 && Math.abs(p.y - cy) <= module * 1.5 && Math.abs(p.module - module) <= Math.max(1, p.module * 0.5)) {
        const k = p.hits;
        p.x = (p.x * k + cx) / (k + 1);
        p.y = (p.y * k + cy) / (k + 1);
        p.module = (p.module * k + module) / (k + 1);
        p.hits++;
        return true;
      }
    }
    centers.push({ x: cx, y: cy, module, hits: 1 });
    return true;
  };

  for (let y = 0; y < height; y += rowStep) {
    c[0] = c[1] = c[2] = c[3] = c[4] = 0;
    let state = 0; // index into c: even = dark run, odd = light run
    const base = y * width * stride + offset;
    const tRow = ((y / block) | 0) * blocksX;
    for (let x = 0; x < width; x++) {
      const dark = data[base + x * stride]! < thr[tRow + colBlock[x]!]!;
      if (dark) {
        if (state & 1) state++; // light → dark
        c[state] = c[state]! + 1;
      } else if (!(state & 1)) {
        if (state === 4) {
          // Completed dark-light-dark-light-dark: test it, then shift by two runs.
          if (isFinderRatio(c) && consider(y, x)) {
            c[0] = c[1] = c[2] = c[3] = c[4] = 0;
            state = 0;
            continue;
          }
          c[0] = c[2]!; c[1] = c[3]!; c[2] = c[4]!; c[3] = 1; c[4] = 0;
          state = 3;
        } else if (c[state]! > 0) {
          state++;
          c[state] = c[state]! + 1;
        }
      } else {
        c[state] = c[state]! + 1;
      }
    }
    if (state === 4 && isFinderRatio(c)) consider(y, width);
  }
  return centers;
}

/**
 * Pick the three centres that best form a QR code: similar module sizes, two
 * near-equal legs at a near-right angle, and a plausible size (versions 1–40).
 * Returns them as [corner, a, b] or null.
 */
export function pickFinderTriple(centers: FinderCenter[]): [FinderCenter, FinderCenter, FinderCenter] | null {
  const cand = centers.slice().sort((p, q) => q.hits - p.hits).slice(0, 12);
  let best: [FinderCenter, FinderCenter, FinderCenter] | null = null;
  let bestErr = Infinity;
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      for (let k = j + 1; k < cand.length; k++) {
        const p = [cand[i]!, cand[j]!, cand[k]!];
        const mods = p.map((f) => f.module);
        const mMin = Math.min(...mods);
        const mMax = Math.max(...mods);
        if (mMax > mMin * 1.6) continue;
        const mod = (mods[0]! + mods[1]! + mods[2]!) / 3;
        // The corner is the vertex opposite the longest side.
        const d = (a: FinderCenter, b: FinderCenter) => Math.hypot(a.x - b.x, a.y - b.y);
        const sides = [d(p[1]!, p[2]!), d(p[0]!, p[2]!), d(p[0]!, p[1]!)];
        const ci = sides.indexOf(Math.max(...sides));
        const corner = p[ci]!;
        const [a, b] = p.filter((_, n) => n !== ci) as [FinderCenter, FinderCenter];
        const la = d(corner, a);
        const lb = d(corner, b);
        const legRatio = Math.max(la, lb) / Math.min(la, lb);
        if (legRatio > 1.4) continue;
        const cos = ((a.x - corner.x) * (b.x - corner.x) + (a.y - corner.y) * (b.y - corner.y)) / (la * lb);
        if (Math.abs(cos) > 0.3) continue; // ≈ 90° ± 17°
        const span = (la + lb) / 2 / mod; // centre-to-centre distance in modules = dimension − 7
        if (span < 12 || span > 175) continue; // v1 (21 − 7 = 14) to v40 (177 − 7 = 170), with slack
        const err = (legRatio - 1) + Math.abs(cos) + (mMax / mMin - 1) - 0.02 * Math.min(10, corner.hits + a.hits + b.hits);
        if (err < bestErr) {
          bestErr = err;
          best = [corner, a, b];
        }
      }
    }
  }
  return best;
}

/** Local-threshold window radius for an image of this size. */
export function binarizeRadius(width: number, height: number): number {
  return Math.max(8, Math.round(Math.min(width, height) / 24));
}

/** Locate a QR code in a greyscale (or RGBA) image, or null if there is none. */
export function locateQr(img: GrayImage, opts: LocateOptions = {}): QrLocation | null {
  const bin = new BinaryImage(img, binarizeRadius(img.width, img.height));
  const triple = pickFinderTriple(findFinderCenters(bin, opts.rowStep ?? 2));
  return triple ? locationFromFinders(triple, img.width, img.height) : null;
}

export function locationFromFinders(f: [FinderCenter, FinderCenter, FinderCenter], width: number, height: number): QrLocation {
  const [tl, a, b] = f;
  const module = (tl.module + a.module + b.module) / 3;
  const la = Math.hypot(a.x - tl.x, a.y - tl.y);
  const lb = Math.hypot(b.x - tl.x, b.y - tl.y);
  const dimension = Math.round((la + lb) / 2 / module) + 7;
  // Fourth corner by parallelogram completion, then pad by the finder half-width
  // (3.5 modules) plus 2 modules of quiet zone, ×√2 for rotation, +6% for perspective.
  const br = { x: a.x + b.x - tl.x, y: a.y + b.y - tl.y };
  const xs = [tl.x, a.x, b.x, br.x];
  const ys = [tl.y, a.y, b.y, br.y];
  const pad = 5.5 * module * Math.SQRT2 + 0.06 * Math.max(la, lb);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(width, Math.ceil(Math.max(...xs) + pad));
  const y1 = Math.min(height, Math.ceil(Math.max(...ys) + pad));
  return { finders: f, module, dimension, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}
