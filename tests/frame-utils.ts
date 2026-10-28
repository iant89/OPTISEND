/** Test-side stand-ins for what the browser scanner does with a canvas. */
import type { QrMatrix } from '../src/qr/encoder.ts';
import type { ScanFrame } from '../src/qr/decoders/types.ts';
import { readFileSync } from 'node:fs';
import { loadZxing } from '../src/qr/decoders/zxing-core.ts';

/** Area-average resize of a grey sub-image (like drawImage with smoothing) → grey w×h. */
export function resizeGray(src: Uint8Array, srcW: number, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = sy + Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, sy + Math.floor((y + 1) * fy));
    for (let x = 0; x < dw; x++) {
      const x0 = sx + Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, sx + Math.floor((x + 1) * fx));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src[yy * srcW + xx]!;
      out[y * dw + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
}

export function grayToRgba(g: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.length * 4);
  for (let i = 0, k = 0; i < g.length; i++, k += 4) { out[k] = out[k + 1] = out[k + 2] = g[i]!; out[k + 3] = 255; }
  return out;
}

/** Render a matrix to RGBA at `scale` px/module with a 4-module quiet zone, optionally offset in a larger canvas. */
export function rasterize(m: QrMatrix, scale: number, pad = 0): ScanFrame {
  const n = m.size + 8;
  const W = n * scale + pad * 2;
  const data = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.modules[y * m.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((pad + (y + 4) * scale + dy) * W + pad + (x + 4) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: W, height: W };
}

export const ZXING_WASM_PATH = 'src/vendor/zxing-wasm/zxing_reader.wasm';

/** Load the vendored ZXing WebAssembly from disk (Node has no fetch of relative URLs). */
export async function loadZxingForTests(): Promise<void> {
  const b = readFileSync(ZXING_WASM_PATH);
  await loadZxing({ wasmBinary: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
}

/** Area-average resize of an RGB (3 bytes per pixel, row width srcW) sub-image → RGBA dw×dh. */
export function resizeRgb(src: Uint8Array, srcW: number, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = sy + Math.floor(y * fy), y1 = Math.max(y0 + 1, sy + Math.floor((y + 1) * fy));
    for (let x = 0; x < dw; x++) {
      const x0 = sx + Math.floor(x * fx), x1 = Math.max(x0 + 1, sx + Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const k = (yy * srcW + xx) * 3; r += src[k]!; g += src[k + 1]!; b += src[k + 2]!; n++; }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
}
