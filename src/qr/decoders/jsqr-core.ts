/** Thin, synchronous wrapper around the vendored jsQR (usable in workers and tests). */
import jsQR from '../../vendor/jsqr/jsQR.cjs';
import type { ScanFrame, ScanHit } from './types.ts';

export interface JsQrOptions {
  /**
   * Apply a 3×3 box filter to luminance before decoding. jsQR binarizes per
   * pixel, so camera sensor noise breaks its finder-pattern detection; in the
   * camera simulation (tests/camera-sim.test.ts) smoothing raised the v15
   * decode rate from 15/24 to 21/24 frames and made decoding faster.
   */
  smooth?: boolean;
}

export function decodeWithJsQr(frame: ScanFrame, opts: JsQrOptions = { smooth: true }): ScanHit | null {
  const data = opts.smooth ? smoothLuma(frame) : frame.data;
  // OptiSend codes are always dark-on-light: skipping the inverted pass halves the work.
  const r = jsQR(data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
  if (!r) return null;
  const l = r.location;
  return {
    text: r.data,
    bytes: Uint8Array.from(r.binaryData),
    version: r.version,
    corners: [l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner],
  };
}

/** Grayscale + separable 3×3 box blur, returned as RGBA (R=G=B). O(pixels). */
export function smoothLuma(frame: ScanFrame): Uint8ClampedArray {
  const { width: w, height: h, data } = frame;
  const n = w * h;
  const g = new Uint16Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (data[j]! * 77 + data[j + 1]! * 150 + data[j + 2]! * 29) >> 8;
  const t = new Uint16Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? x - 1 : x;
      const r = x < w - 1 ? x + 1 : x;
      t[row + x] = g[row + l]! + g[row + x]! + g[row + r]!;
    }
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : y) * w;
    const mid = y * w;
    const dn = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const v = ((t[up + x]! + t[mid + x]! + t[dn + x]!) * 7282) >> 16; // ≈ /9
      const k = (mid + x) * 4;
      out[k] = out[k + 1] = out[k + 2] = v;
      out[k + 3] = 255;
    }
  }
  return out;
}
