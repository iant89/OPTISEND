import type { ChunkBitmap } from '../../protocol/bitmap.ts';
import { SEG_EMPTY, SEG_FILLED } from '../../components/SegmentedBar.tsx';

/**
 * Display states for a file's chunk bitmap. Up to `max` chunks map 1:1; beyond
 * that, each segment covers a bucket of chunks and shows filled only when the
 * whole bucket is received — the bar never overstates progress (exact counts
 * are shown as text alongside).
 */
export function bitmapToSegments(bitmap: ChunkBitmap, max = 4096): Uint8Array {
  const n = bitmap.size;
  if (n <= max) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = bitmap.has(i) ? SEG_FILLED : SEG_EMPTY;
    return out;
  }
  const out = new Uint8Array(max);
  for (let b = 0; b < max; b++) {
    const start = Math.floor((b * n) / max);
    const end = Math.floor(((b + 1) * n) / max);
    let all = true;
    for (let i = start; i < end && all; i++) all = bitmap.has(i);
    out[b] = all ? SEG_FILLED : SEG_EMPTY;
  }
  return out;
}
