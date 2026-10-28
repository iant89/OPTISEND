/**
 * Test-only reader for PIXEL-PERFECT QR images (our own canvas output): reads
 * modules, unmasks, de-interleaves, checks every Reed–Solomon block, and
 * returns the exact segment bytes. Unlike desktop decoders it never turns
 * byte-mode content into text, so it can verify the binary transport.
 * It is not a camera decoder (no perspective, no error correction).
 */
import { ECC_CODEWORDS_PER_BLOCK, NUM_ECC_BLOCKS, rawDataModules, type EccLevel } from '../src/qr/capacity.ts';
import { dataModuleIndices, formatBits, maskInverts, rsDivisor, rsRemainder } from '../src/qr/encoder.ts';

export function readPixelPerfectQr(size: number, modules: Uint8Array): { version: number; ecc: EccLevel; mask: number; content: Uint8Array | string } {
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 40) throw new Error(`bad size ${size}`);
  const at = (x: number, y: number) => modules[y * size + x]!;
  let f = 0;
  const seq = [at(8, 0), at(8, 1), at(8, 2), at(8, 3), at(8, 4), at(8, 5), at(8, 7), at(8, 8), at(7, 8)];
  for (let i = 9; i < 15; i++) seq.push(at(14 - i, 8));
  seq.forEach((b, i) => { if (b) f |= 1 << i; });
  let ecc: EccLevel | null = null;
  let mask = -1;
  for (const e of ['L', 'M', 'Q', 'H'] as EccLevel[]) for (let m = 0; m < 8; m++) if (formatBits(e, m) === f) { ecc = e; mask = m; }
  if (!ecc) throw new Error('format information unreadable');

  const order = dataModuleIndices(version);
  const raw = Math.floor(rawDataModules(version) / 8);
  const cw = new Uint8Array(raw);
  for (let i = 0; i < raw * 8; i++) {
    const idx = order[i]!;
    const bit = modules[idx]! ^ (maskInverts(mask, idx % size, Math.floor(idx / size)) ? 1 : 0);
    cw[i >>> 3]! |= bit << (7 - (i & 7));
  }
  // De-interleave (inverse of the encoder's interleaving) and check each block's ECC.
  const numBlocks = NUM_ECC_BLOCKS[ecc][version]!;
  const eccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version]!;
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const blocks = Array.from({ length: numBlocks }, (_, j) => new Uint8Array(shortLen + (j < numShort ? 0 : 1)));
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i === shortLen - eccLen && j < numShort) continue;
      const bi = j < numShort && i > shortLen - eccLen ? i - 1 : i;
      blocks[j]![bi] = cw[k++]!;
    }
  }
  const div = rsDivisor(eccLen);
  const data: number[] = [];
  for (const b of blocks) {
    const d = b.subarray(0, b.length - eccLen);
    const e = b.subarray(b.length - eccLen);
    if (rsRemainder(d, div).some((v, i) => v !== e[i])) throw new Error('Reed–Solomon check failed');
    data.push(...d);
  }
  // Parse the single segment.
  let pos = 0;
  const read = (n: number) => { let v = 0; for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((data[pos >>> 3]! >>> (7 - (pos & 7))) & 1); return v; };
  const mode = read(4);
  if (mode === 0b0100) {
    const len = read(version <= 9 ? 8 : 16);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = read(8);
    return { version, ecc, mask, content: out };
  }
  if (mode === 0b0010) {
    const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
    const len = read(version <= 9 ? 9 : version <= 26 ? 11 : 13);
    let s = '';
    for (let i = 0; i + 1 < len; i += 2) { const v = read(11); s += A[Math.floor(v / 45)]! + A[v % 45]!; }
    if (len % 2) s += A[read(6)]!;
    return { version, ecc, mask, content: s };
  }
  throw new Error(`unsupported mode ${mode}`);
}

/** Browser-side: sample module centres from the transmit canvas. Runs inside page.evaluate. */
export const SAMPLE_CANVAS_FN = `(() => {
  const c = document.querySelector('.transmit .qr-canvas');
  if (!c || c.hidden || !c.width) return null;
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const W = c.width;
  const dark = (x, y) => d[(y * W + x) * 4] < 128;
  let off = 0;
  while (off < W && !dark(off, off)) off++;          // top-left finder corner = 4 modules of quiet zone
  const m = off / 4;
  const n = Math.round(W / m) - 8;
  const bits = new Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) bits[y * n + x] = dark(Math.floor(off + (x + 0.5) * m), Math.floor(off + (y + 0.5) * m)) ? 1 : 0;
  return { n, m, bits: bits.join('') };
})()`;
