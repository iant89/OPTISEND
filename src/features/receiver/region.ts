/**
 * Scan-region geometry (spec §9.3: restrict detection to a defined region).
 * Pure functions, unit-tested.
 */

export interface ScanRegion {
  /** Source square in video pixels. */
  sx: number;
  sy: number;
  sSize: number;
  /** Destination size (square) after downscaling, in pixels. */
  dSize: number;
}

/**
 * Centered square covering `fraction` of the video's shorter side, downscaled
 * so that its side is at most `maxSide` pixels (never upscaled).
 */
export function scanRegion(videoW: number, videoH: number, fraction: number, maxSide: number): ScanRegion {
  const f = Math.min(1, Math.max(0.1, fraction));
  const sSize = Math.max(1, Math.floor(Math.min(videoW, videoH) * f));
  return {
    sx: Math.floor((videoW - sSize) / 2),
    sy: Math.floor((videoH - sSize) / 2),
    sSize,
    dSize: Math.max(1, Math.min(sSize, Math.floor(maxSide))),
  };
}

/**
 * Pixels needed across the scan region to sample a code of `version` reliably,
 * assuming the code fills about 60% of the region and ~6 px per module.
 */
export function targetScanSide(version: number | null): number {
  if (!version) return 960;
  const modules = 17 + 4 * version + 8; // including quiet zone
  return Math.min(1600, Math.max(640, Math.round((modules * 6) / 0.6)));
}

/**
 * Shorter side (px) of the downscaled whole frame the locator searches: half
 * the video. Any code jsQR can decode has ≥ ~4 px per module at full
 * resolution, so it still has ≥ ~2 px per module here, enough to find its
 * finder patterns; smaller codes would not decode anyway.
 */
export function locatorSide(videoShort: number): number {
  return Math.max(1, Math.min(videoShort, Math.max(360, Math.round(videoShort / 2))));
}

/** Locator box in the downscaled frame's pixels, plus its estimated module size. */
export interface LocatedBox {
  x: number;
  y: number;
  w: number;
  h: number;
  module: number;
}

/**
 * Square scan region (video pixels) around a located code, scaled so the
 * decoder gets ~8 px per module (capped at 1600 px, never upscaled).
 * `scale` = downscaled-frame px per video px.
 */
export function regionForBox(box: LocatedBox, scale: number, videoW: number, videoH: number): ScanRegion {
  const side = Math.min(videoW, videoH, Math.ceil(Math.max(box.w, box.h) / scale));
  const cx = (box.x + box.w / 2) / scale;
  const cy = (box.y + box.h / 2) / scale;
  const sx = Math.round(Math.min(Math.max(0, cx - side / 2), videoW - side));
  const sy = Math.round(Math.min(Math.max(0, cy - side / 2), videoH - side));
  const modulesAcross = Math.max(box.w, box.h) / box.module;
  return { sx, sy, sSize: side, dSize: Math.max(1, Math.min(side, 1600, Math.ceil(modulesAcross * 8))) };
}

/**
 * Where the scan region appears on screen when the video is shown with
 * `object-fit: cover` inside an element of size elW × elH.
 */
export function regionOnElement(videoW: number, videoH: number, elW: number, elH: number, r: ScanRegion): { left: number; top: number; size: number } {
  const scale = Math.max(elW / videoW, elH / videoH);
  const offX = (elW - videoW * scale) / 2;
  const offY = (elH - videoH * scale) / 2;
  return { left: offX + r.sx * scale, top: offY + r.sy * scale, size: r.sSize * scale };
}
