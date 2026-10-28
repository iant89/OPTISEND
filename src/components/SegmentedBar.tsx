import { useEffect, useRef } from 'react';

/** Segment states. */
export const SEG_EMPTY = 0;
export const SEG_FILLED = 1;
export const SEG_CURRENT = 2;
export const SEG_ERROR = 3;

interface Props {
  /** One entry per segment (chunk / frame). */
  states: Uint8Array;
  /** Bumped by the caller whenever `states` is mutated in place. */
  version: number;
  label: string;
  /** Text equivalent of the value, e.g. "37 of 120 frames". */
  valueText: string;
  filled: number;
}

/**
 * Torrent-style segmented bar (spec §3.5) drawn on a canvas so it scales to
 * tens of thousands of segments: when segments outnumber pixels, each pixel
 * column shows the fraction of its segments that are filled. Errors and the
 * current segment are always drawn on top so they stay visible.
 */
export function SegmentedBar({ states, version, label, valueText, filled }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const cs = getComputedStyle(canvas);
      const cEmpty = cs.getPropertyValue('--seg-empty').trim() || '#ddd';
      const cFill = cs.getPropertyValue('--seg-fill').trim() || '#2563eb';
      const cCur = cs.getPropertyValue('--seg-current').trim() || '#f59e0b';
      const cErr = cs.getPropertyValue('--seg-error').trim() || '#dc2626';
      ctx.fillStyle = cEmpty;
      ctx.fillRect(0, 0, w, h);
      const n = states.length;
      if (n === 0) return;
      const gap = n <= w / 4 ? Math.max(1, Math.floor(dpr)) : 0;
      const marks: [number, string][] = [];
      if (n <= w) {
        for (let i = 0; i < n; i++) {
          const x0 = Math.round((i * w) / n);
          const x1 = Math.round(((i + 1) * w) / n) - gap;
          const s = states[i]!;
          if (s === SEG_FILLED) { ctx.fillStyle = cFill; ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h); }
          else if (s === SEG_CURRENT || s === SEG_ERROR) marks.push([i, s === SEG_CURRENT ? cCur : cErr]);
          else if (gap) { ctx.clearRect(x1, 0, gap, h); }
        }
      } else {
        for (let x = 0; x < w; x++) {
          const a = Math.floor((x * n) / w);
          const b = Math.max(a + 1, Math.floor(((x + 1) * n) / w));
          let f = 0;
          for (let i = a; i < b; i++) {
            const s = states[i]!;
            if (s === SEG_FILLED) f++;
            else if (s === SEG_CURRENT || s === SEG_ERROR) marks.push([i, s === SEG_CURRENT ? cCur : cErr]);
          }
          if (f > 0) {
            ctx.globalAlpha = 0.25 + 0.75 * (f / (b - a));
            ctx.fillStyle = cFill;
            ctx.fillRect(x, 0, 1, h);
            ctx.globalAlpha = 1;
          }
        }
      }
      for (const [i, color] of marks) {
        const x0 = Math.floor((i * w) / n);
        ctx.fillStyle = color;
        ctx.fillRect(x0, 0, Math.max(Math.ceil(2 * dpr), Math.round(w / n) - gap), h);
      }
    };
    draw();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null;
    ro?.observe(canvas);
    return () => ro?.disconnect();
  }, [states, version]);

  return (
    <canvas
      ref={ref}
      className="segbar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={states.length}
      aria-valuenow={filled}
      aria-valuetext={valueText}
    />
  );
}
