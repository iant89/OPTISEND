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

/** Draw `qr` onto `canvas` at the largest crisp size fitting `availableCssPx`. */
export function drawQr(canvas: CanvasLike, qr: QrMatrix, availableCssPx: number, devicePixelRatio = 1, quietZone = DEFAULT_QUIET_ZONE): QrLayout {
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
