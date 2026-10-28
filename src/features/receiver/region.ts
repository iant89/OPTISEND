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
 * Where the scan region appears on screen when the video is shown with
 * `object-fit: cover` inside an element of size elW × elH.
 */
export function regionOnElement(videoW: number, videoH: number, elW: number, elH: number, r: ScanRegion): { left: number; top: number; size: number } {
  const scale = Math.max(elW / videoW, elH / videoH);
  const offX = (elW - videoW * scale) / 2;
  const offY = (elH - videoH * scale) / 2;
  return { left: offX + r.sx * scale, top: offY + r.sy * scale, size: r.sSize * scale };
}
