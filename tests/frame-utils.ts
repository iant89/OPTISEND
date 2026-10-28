/** Test-side stand-ins for what the browser scanner does with a canvas. */

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
