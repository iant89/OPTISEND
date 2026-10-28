/**
 * Colour-layer QR (experimental): the sender overlays three codes in the red,
 * green and blue channels. The receiver detects such frames by their share of
 * saturated pixels and decodes each channel as a grey image.
 */
import type { ScanFrame } from './decoders/types.ts';

/** Sampled pixels whose channel spread (max − min, after per-channel stretch) exceeds this count as coloured. */
export const SATURATED_SPREAD = 64;
/**
 * A frame is a colour frame when at least this share of sampled pixels is
 * coloured. Simulated captures: black-and-white codes ≤ 0.02 even under a
 * strong colour cast; colour codes ≥ 0.3 when located, ~0.1 when only partly
 * inside the guide square.
 */
export const COLOUR_FRAME_SHARE = 0.05;

/**
 * Share of coloured pixels, sampling every `step`-th pixel in each direction.
 * Each channel is first stretched to its own 2nd–98th percentile range, so a
 * colour cast (white balance, screen tint) on a black-and-white code does not
 * count as colour; in a three-layer code, 6 of the 8 module colours stay saturated.
 */
export function colourShare(f: ScanFrame, step = 4): number {
  const { data, width, height } = f;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const k = (y * width + x) * 4;
    hist[0]![data[k]!]!++; hist[1]![data[k + 1]!]!++; hist[2]![data[k + 2]!]!++;
    n++;
  }
  if (!n) return 0;
  const pct = (h: Uint32Array, q: number) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += h[v]!; if (acc >= q * n) return v; } return 255; };
  const lo = hist.map((h) => pct(h, 0.02)), hi = hist.map((h) => pct(h, 0.98));
  const scale = lo.map((l, c) => 255 / Math.max(16, hi[c]! - l));
  let coloured = 0;
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const k = (y * width + x) * 4;
    const r = (data[k]! - lo[0]!) * scale[0]!, g = (data[k + 1]! - lo[1]!) * scale[1]!, b = (data[k + 2]! - lo[2]!) * scale[2]!;
    if (Math.max(r, g, b) - Math.min(r, g, b) > SATURATED_SPREAD) coloured++;
  }
  return coloured / n;
}

export function isColourFrame(f: ScanFrame): boolean {
  return colourShare(f) >= COLOUR_FRAME_SHARE;
}

/** How the camera mixed the sender's channels: camera = K + A·screen (screen in 0…1), stored inverted. */
export interface ColourMix {
  /** Camera colour of black (all three codes dark). */
  black: [number, number, number];
  /** A⁻¹, scaled so unmixed channels span 0…255. */
  inverse: number[][];
}

/**
 * The three channels (0 red, 1 green, 2 blue) as grey RGBA frames, in one pass.
 * With `mix`, the camera's colour mixing is undone first.
 */
export function splitChannels(f: ScanFrame, mix: ColourMix | null = null): [ScanFrame, ScanFrame, ScanFrame] {
  const { data, width, height } = f;
  const src = new Int32Array(data.buffer, data.byteOffset, width * height);
  const outs = [0, 1, 2].map(() => new Uint8ClampedArray(width * height * 4));
  // Int32 views: little-endian RGBA as one word; grey g is 0xff000000 | g·0x010101 (negative as int32).
  const [o0, o1, o2] = outs.map((o) => new Int32Array(o.buffer)) as [Int32Array, Int32Array, Int32Array];
  const OPAQUE = 0xff000000 | 0;
  if (!mix) {
    for (let i = 0; i < src.length; i++) {
      const p = src[i]!;
      o0[i] = OPAQUE | ((p & 0xff) * 0x010101);
      o1[i] = OPAQUE | (((p >>> 8) & 0xff) * 0x010101);
      o2[i] = OPAQUE | (((p >>> 16) & 0xff) * 0x010101);
    }
  } else {
    const [k0, k1, k2] = mix.black;
    const [[a, b, c], [d, e, g], [h, j, k]] = mix.inverse as [[number, number, number], [number, number, number], [number, number, number]];
    for (let i = 0; i < src.length; i++) {
      const p = src[i]!;
      const r = (p & 0xff) - k0, gr = ((p >>> 8) & 0xff) - k1, bl = ((p >>> 16) & 0xff) - k2;
      let v0 = (a * r + b * gr + c * bl) | 0, v1 = (d * r + e * gr + g * bl) | 0, v2 = (h * r + j * gr + k * bl) | 0;
      v0 = v0 < 0 ? 0 : v0 > 255 ? 255 : v0;
      v1 = v1 < 0 ? 0 : v1 > 255 ? 255 : v1;
      v2 = v2 < 0 ? 0 : v2 > 255 ? 255 : v2;
      o0[i] = OPAQUE | (v0 * 0x010101);
      o1[i] = OPAQUE | (v1 * 0x010101);
      o2[i] = OPAQUE | (v2 * 0x010101);
    }
  }
  return outs.map((o) => ({ data: o, width, height })) as [ScanFrame, ScanFrame, ScanFrame];
}

/**
 * Undo colour mixing between screen and camera (crosstalk, white balance),
 * estimated from the frame itself. A three-layer frame shows exactly eight
 * module colours (each channel dark or light), so sampled pixels form eight
 * clusters: camera colour = K + A·e for screen corners e ∈ {0,1}³, where K is
 * black and column j of A is what lighting screen channel j alone adds.
 *  1. k-means finds the eight centres, seeded at the cube corners spanned by
 *     the observed channel ranges; an empty cluster moves to the worst-fitted
 *     sample (heavy mixing puts real colours far from the corners).
 *  2. Black is the darkest centre, white the brightest. Of the other six, the
 *     single-channel colours K + A_j are the triple whose pairwise sums minus K
 *     best match the remaining three (K + A_i + A_j) and white.
 *  3. Each single-channel colour is assigned to the camera channel it raises
 *     most (the sender's red drives the camera's red most, and so on).
 * Returns null when the frame has no such structure (not a colour frame);
 * callers then use the raw channels. Apply the result with splitChannels.
 */
export function estimateColourMix(f: ScanFrame, maxSamples = 8000, iterations = 10): ColourMix | null {
  const { data, width, height } = f;
  // Sample on a grid of at most ~maxSamples pixels: P holds r,g,b triples.
  const step = Math.max(2, Math.ceil(Math.sqrt((width * height) / maxSamples)));
  const P = new Float32Array(Math.ceil(width / step) * Math.ceil(height / step) * 3);
  let n = 0;
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const k = (y * width + x) * 4;
    P[n * 3] = data[k]!; P[n * 3 + 1] = data[k + 1]!; P[n * 3 + 2] = data[k + 2]!;
    n++;
  }
  if (n < 64) return null;
  const sum3 = (p: readonly number[]) => p[0]! + p[1]! + p[2]!;
  const d2 = (p: readonly number[], q: readonly number[]) => (p[0]! - q[0]!) ** 2 + (p[1]! - q[1]!) ** 2 + (p[2]! - q[2]!) ** 2;

  // 1. Seeds: the RGB cube corners spanned by each channel's 2nd–98th percentile. Robust to the
  // blended pixels at module edges; labels come from step 2, not from these seeds.
  const C = new Float64Array(24); // eight centres, r,g,b each
  for (let c = 0; c < 3; c++) {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = P[i * 3 + c]!;
    v.sort();
    const lo = v[Math.floor(n * 0.02)]!, hi = v[Math.floor(n * 0.98)]!;
    for (let k = 0; k < 8; k++) C[k * 3 + c] = (k >> c) & 1 ? hi : lo;
  }
  const counts = new Float64Array(8);
  const acc = new Float64Array(24);
  const far = new Float32Array(n);
  for (let it = 0; it < iterations; it++) {
    acc.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const r = P[i * 3]!, g = P[i * 3 + 1]!, b = P[i * 3 + 2]!;
      let best = 0, bestD = Infinity;
      for (let k = 0; k < 8; k++) {
        const dr = r - C[k * 3]!, dg = g - C[k * 3 + 1]!, db = b - C[k * 3 + 2]!;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = k; }
      }
      far[i] = bestD;
      acc[best * 3] = acc[best * 3]! + r; acc[best * 3 + 1] = acc[best * 3 + 1]! + g; acc[best * 3 + 2] = acc[best * 3 + 2]! + b;
      counts[best] = counts[best]! + 1;
    }
    for (let k = 0; k < 8; k++) {
      if (counts[k]! > 0) {
        for (let c = 0; c < 3; c++) C[k * 3 + c] = acc[k * 3 + c]! / counts[k]!;
        continue;
      }
      // Empty cluster (its seed was far from every real colour): move it to the worst-fitted sample.
      let worst = 0;
      for (let i = 1; i < n; i++) if (far[i]! > far[worst]!) worst = i;
      for (let c = 0; c < 3; c++) C[k * 3 + c] = P[worst * 3 + c]!;
      far[worst] = 0;
    }
  }
  // All eight module colours must actually occur (each is about 1/8 of the data area); a
  // black-and-white frame leaves six clusters empty at their seeds.
  for (let k = 0; k < 8; k++) if (counts[k]! < n * MIN_CLUSTER_SHARE) return null;
  const centres = Array.from({ length: 8 }, (_, k) => [C[k * 3]!, C[k * 3 + 1]!, C[k * 3 + 2]!]);

  // 2. Label: black, white, and the single-channel triple that best explains the rest.
  const order = centres.map((_, k) => k).sort((p, q) => sum3(centres[p]!) - sum3(centres[q]!));
  const K = centres[order[0]!]!, Wt = centres[order[7]!]!;
  const mid = order.slice(1, 7).map((k) => centres[k]!);
  const add = (p: readonly number[], q: readonly number[]) => [p[0]! + q[0]! - K[0]!, p[1]! + q[1]! - K[1]!, p[2]! + q[2]! - K[2]!];
  let singles: number[][] | null = null, bestErr = Infinity;
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) for (let k = j + 1; k < 6; k++) {
    const s = [mid[i]!, mid[j]!, mid[k]!];
    const doubles = mid.filter((_, n) => n !== i && n !== j && n !== k);
    const predicted = [add(s[0]!, s[1]!), add(s[0]!, s[2]!), add(s[1]!, s[2]!)];
    // Match predicted doubles to the remaining centres greedily, plus white.
    const left = [...doubles];
    let err = d2(add(add(s[0]!, s[1]!), s[2]!), Wt);
    for (const pr of predicted) {
      let bi = 0;
      for (let n = 1; n < left.length; n++) if (d2(pr, left[n]!) < d2(pr, left[bi]!)) bi = n;
      err += d2(pr, left[bi]!);
      left.splice(bi, 1);
    }
    if (err < bestErr) { bestErr = err; singles = s; }
  }
  if (!singles) return null;

  // 3. Columns A_j = single_j − K, permuted so camera channel j is the one column j raises most.
  const cols = singles.map((s) => [s[0]! - K[0]!, s[1]! - K[1]!, s[2]! - K[2]!]);
  let perm = [0, 1, 2], bestDiag = -Infinity;
  for (const p of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const diag = cols[p[0]!]![0]! + cols[p[1]!]![1]! + cols[p[2]!]![2]!;
    if (diag > bestDiag) { bestDiag = diag; perm = p; }
  }
  const A = [0, 1, 2].map((row) => [0, 1, 2].map((j) => cols[perm[j]!]![row]!));
  // Each screen channel must visibly change its own camera channel, and the three columns must
  // point in clearly different directions (normalised volume), or this is not a colour frame:
  // a black-and-white image gives three near-parallel columns.
  for (let j = 0; j < 3; j++) if (A[j]![j]! < 24) return null;
  const norms = [0, 1, 2].map((j) => Math.hypot(A[0]![j]!, A[1]![j]!, A[2]![j]!));
  if (Math.abs(det3(A)) < MIN_COLOUR_VOLUME * norms[0]! * norms[1]! * norms[2]!) return null;
  const inv = invert3(A);
  if (!inv) return null;
  return { black: [K[0]!, K[1]!, K[2]!], inverse: inv.map((row) => row.map((v) => v * 255)) };
}

/** Smallest share of sampled pixels each of the eight colour clusters must hold. */
const MIN_CLUSTER_SHARE = 0.02;

/** |det| / product of column lengths below this: the colour fit is degenerate. Orthogonal columns give 1. */
const MIN_COLOUR_VOLUME = 0.05;

function det3(m: number[][]): number {
  const [a, b, c] = m[0]!, [d, e, f] = m[1]!, [g, h, i] = m[2]!;
  return a! * (e! * i! - f! * h!) - b! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!);
}

function invert3(m: number[][]): number[][] | null {
  const [a, b, c] = m[0]!, [d, e, f] = m[1]!, [g, h, i] = m[2]!;
  const A = e! * i! - f! * h!, B = -(d! * i! - f! * g!), C = d! * h! - e! * g!;
  const det = a! * A + b! * B + c! * C;
  if (Math.abs(det) < 1e-6) return null;
  return [
    [A / det, -(b! * i! - c! * h!) / det, (b! * f! - c! * e!) / det],
    [B / det, (a! * i! - c! * g!) / det, -(a! * f! - c! * d!) / det],
    [C / det, -(a! * h! - b! * g!) / det, (a! * e! - b! * d!) / det],
  ];
}
