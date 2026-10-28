/**
 * Duplicate-frame check: at 30 fps the camera sees each code several times.
 * Once a frame's codes have all decoded, later frames that look the same (same
 * code, same place) are skipped instead of decoded again.
 */

/** 32×32 area-average thumbnail of a square RGBA frame, from the green channel. */
export function frameThumb(rgba: Uint8ClampedArray, side: number, n = 32): Float32Array {
  const out = new Float32Array(n * n);
  const f = side / n;
  for (let ty = 0; ty < n; ty++) {
    const y0 = Math.floor(ty * f), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * f));
    for (let tx = 0; tx < n; tx++) {
      const x0 = Math.floor(tx * f), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * f));
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += rgba[(y * side + x) * 4 + 1]!;
      out[ty * n + tx] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/**
 * Mean absolute thumbnail difference below which two frames show the same code
 * in the same place. Send-rate simulator: the same frame differs by ≤ 0.1 (noise),
 * different codes — including the same packet with the next pass's mask — by ≥ 13.
 */
export const SAME_FRAME_MAD = 6;

export function isSameFrame(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
  return d / a.length < SAME_FRAME_MAD;
}
