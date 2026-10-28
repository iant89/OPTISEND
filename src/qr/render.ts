/**
 * Crisp QR rendering (spec §3.3): every module is a whole number of *device*
 * pixels, so the code is never blurred or resampled, and the quiet zone is
 * always present. Pure layout math is separated from canvas drawing for tests.
 */

import type { QrMatrix } from './encoder.ts';

export const DEFAULT_QUIET_ZONE = 4;

export interface QrLayout {
  /** Device pixels per module (integer ≥ 1). */
  modulePx: number;
  /** Canvas backing-store size in device pixels (square). */
  canvasPx: number;
  /** CSS size to give the canvas so 1 backing pixel = 1 device pixel. */
  cssPx: number;
  quietZone: number;
  /** True if even 1 device pixel per module does not fit the available space. */
  tooSmall: boolean;
}

export function qrLayout(moduleCount: number, availableCssPx: number, devicePixelRatio = 1, quietZone = DEFAULT_QUIET_ZONE): QrLayout {
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  const total = moduleCount + quietZone * 2;
  const availableDevice = Math.floor(Math.max(0, availableCssPx) * dpr);
  const fit = Math.floor(availableDevice / total);
  const modulePx = Math.max(1, fit);
  const canvasPx = modulePx * total;
  return { modulePx, canvasPx, cssPx: canvasPx / dpr, quietZone, tooSmall: fit < 1 };
}

export interface CanvasLike {
  width: number;
  height: number;
  style?: { width: string; height: string };
  getContext(id: '2d'): CanvasRenderingContext2D | null;
}

/**
 * Colour composite of up to three same-size codes: code i drives channel i
 * (red, green, blue). A module is dark in a channel when that code's module is
 * dark, so function patterns shared by all codes are black and the quiet zone
 * white. Fewer than three codes repeat cyclically. Returns RGBA at one pixel per
 * module (quiet zone included).
 */
export function compositeRgb(codes: readonly QrMatrix[], quietZone = DEFAULT_QUIET_ZONE): { side: number; rgba: Uint8ClampedArray } {
  const n = codes[0]!.size;
  if (codes.some((c) => c.size !== n)) throw new Error('colour layers must be the same QR version');
  const side = n + quietZone * 2;
  const rgba = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const k = ((y + quietZone) * side + x + quietZone) * 4;
      for (let c = 0; c < 3; c++) if (codes[c % codes.length]!.modules[y * n + x]) rgba[k + c] = 0;
    }
  }
  return { side, rgba };
}

/**
 * Draw `qr` onto `canvas` at the largest crisp size fitting `availableCssPx`.
 * An array of several codes is drawn as a colour composite (see compositeRgb).
 */
export function drawQr(canvas: CanvasLike, qrOrLayers: QrMatrix | readonly QrMatrix[], availableCssPx: number, devicePixelRatio = 1, quietZone = DEFAULT_QUIET_ZONE): QrLayout {
  const layers = Array.isArray(qrOrLayers) ? (qrOrLayers as readonly QrMatrix[]) : [qrOrLayers as QrMatrix];
  const qr = layers[0]!;
  const layout = qrLayout(qr.size, availableCssPx, devicePixelRatio, quietZone);
  if (canvas.width !== layout.canvasPx) canvas.width = layout.canvasPx;
  if (canvas.height !== layout.canvasPx) canvas.height = layout.canvasPx;
  if (canvas.style) {
    canvas.style.width = `${layout.cssPx}px`;
    canvas.style.height = `${layout.cssPx}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return layout;
  ctx.imageSmoothingEnabled = false;
  if (layers.length > 1) {
    // Expand each module to modulePx × modulePx device pixels: crisp, no resampling.
    const { side, rgba } = compositeRgb(layers, quietZone);
    const m = layout.modulePx;
    const img = ctx.createImageData(layout.canvasPx, layout.canvasPx);
    const out = new Uint32Array(img.data.buffer);
    const src = new Uint32Array(rgba.buffer);
    for (let y = 0; y < layout.canvasPx; y++) {
      const row = ((y / m) | 0) * side;
      for (let x = 0; x < layout.canvasPx; x++) out[y * layout.canvasPx + x] = src[row + ((x / m) | 0)]!;
    }
    ctx.putImageData(img, 0, 0);
    return layout;
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, layout.canvasPx, layout.canvasPx);
  ctx.fillStyle = '#000000';
  const m = layout.modulePx;
  const off = quietZone * m;
  const n = qr.size;
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!qr.modules[y * n + x]) { x++; continue; }
      const start = x;
      while (x < n && qr.modules[y * n + x]) x++;
      ctx.fillRect(off + start * m, off + y * m, (x - start) * m, m);
    }
  }
  return layout;
}
