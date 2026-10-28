import { useEffect, useRef } from 'react';
import type { QrMatrix } from '../qr/encoder.ts';
import { drawQr } from '../qr/render.ts';

interface Props {
  matrix: QrMatrix | null;
  /** Accessible description of what the code contains. */
  label: string;
  className?: string;
  /** Cap on CSS size (e.g. for previews). */
  maxCssPx?: number;
}

/**
 * Renders a QR matrix at the largest crisp size that fits its container
 * (integer device pixels per module, quiet zone included, never stretched).
 */
export function QrCanvas({ matrix, label, className, maxCssPx }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const matrixRef = useRef<QrMatrix | null>(matrix);
  matrixRef.current = matrix;

  const redraw = () => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    const m = matrixRef.current;
    if (!box || !canvas || !m) return;
    const avail = Math.min(box.clientWidth, box.clientHeight || box.clientWidth, maxCssPx ?? Infinity);
    drawQr(canvas, m, avail, window.devicePixelRatio || 1);
  };

  useEffect(redraw, [matrix, maxCssPx]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(box);
    // devicePixelRatio changes (zoom, moving between monitors) also need a redraw.
    const mq = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq?.addEventListener?.('change', redraw);
    return () => {
      ro.disconnect();
      mq?.removeEventListener?.('change', redraw);
    };
  }, []);

  return (
    <div ref={boxRef} className={`qr-box ${className ?? ''}`}>
      <canvas ref={canvasRef} role="img" aria-label={label} className="qr-canvas" hidden={!matrix} />
    </div>
  );
}
