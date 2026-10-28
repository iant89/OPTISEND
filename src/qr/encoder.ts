/**
 * Dependency-free QR Code Model 2 encoder (ISO/IEC 18004).
 *
 * Supports exactly what OptiSend needs: one segment in byte or alphanumeric
 * mode, ECC levels L/M/Q/H, an explicit or automatic version, and automatic
 * or forced masking. Structure follows the well-known reference design
 * (Project Nayuki's qrcodegen); correctness is verified by decoding the output
 * with independent decoders (scripts/verify_qr_encoder.py).
 */

import type { QrContent } from '../protocol/transport.ts';
import {
  alphanumericCapacity, byteCapacity, ECC_CODEWORDS_PER_BLOCK, MAX_VERSION, MIN_VERSION, NUM_ECC_BLOCKS,
  dataCodewords, rawDataModules, type EccLevel,
} from './capacity.ts';

export interface QrMatrix {
  version: number;
  ecc: EccLevel;
  mask: number;
  /** Modules per side (excluding quiet zone). */
  size: number;
  /** Row-major, 1 = dark. */
  modules: Uint8Array;
}

export interface EncodeOptions {
  ecc: EccLevel;
  /**
   * Smallest version to use. The encoder uses this version if the content
   * fits, otherwise the smallest larger one that does. Default 1.
   * Use it to keep every frame of a transfer at a constant module size.
   */
  minVersion?: number;
  /** Largest version allowed; throws if the content needs more. Default 40. */
  maxVersion?: number;
  /** Force a mask pattern 0–7; default chooses the lowest-penalty mask. */
  mask?: number;
}

export class QrCapacityError extends Error {
  override name = 'QrCapacityError';
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// ─────────────────────────── Public API ───────────────────────────

export function encodeQr(content: QrContent, opts: EncodeOptions): QrMatrix {
  const { ecc } = opts;
  const minV = opts.minVersion ?? MIN_VERSION;
  const maxV = opts.maxVersion ?? MAX_VERSION;
  if (!Number.isInteger(minV) || !Number.isInteger(maxV) || minV < MIN_VERSION || maxV > MAX_VERSION || minV > maxV) {
    throw new RangeError(`invalid version range ${minV}..${maxV}`);
  }
  if (opts.mask !== undefined && (!Number.isInteger(opts.mask) || opts.mask < 0 || opts.mask > 7)) throw new RangeError('mask must be 0–7');

  const length = content.mode === 'byte' ? content.bytes.length : content.text.length;
  if (content.mode === 'alphanumeric') {
    for (let i = 0; i < content.text.length; i++) if (ALNUM.indexOf(content.text[i]!) < 0) throw new RangeError(`character ${JSON.stringify(content.text[i])} is not QR alphanumeric`);
  }
  let version = -1;
  for (let v = minV; v <= maxV; v++) {
    const cap = content.mode === 'byte' ? byteCapacity(v, ecc) : alphanumericCapacity(v, ecc);
    if (length <= cap) { version = v; break; }
  }
  if (version < 0) throw new QrCapacityError(`content of length ${length} does not fit version ${maxV}-${ecc} (${content.mode})`);

  const codewords = addEccAndInterleave(buildDataCodewords(content, version, ecc), version, ecc);
  const qr = new Builder(version);
  qr.drawFunctionPatterns(ecc);
  qr.drawCodewords(codewords);

  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      qr.applyMask(m);
      qr.drawFormatBits(ecc, m);
      const p = qr.penalty();
      if (p < best) { best = p; mask = m; }
      qr.applyMask(m); // XOR undo
    }
  }
  qr.applyMask(mask);
  qr.drawFormatBits(ecc, mask);
  return { version, ecc, mask, size: qr.size, modules: qr.modules };
}

/**
 * Indices (row-major) of the "remainder bit" modules that follow the last
 * codeword. They carry no information; ISO 18004 sets them to 0 before
 * masking, but decoders ignore them (some encoders write other values).
 */
export function dataModuleIndices(version: number): number[] {
  const b = new Builder(version);
  b.drawFunctionPatterns('L');
  return b.dataModuleOrder();
}

/** True if mask pattern `mask` inverts the module at column x, row y. */
export function maskInverts(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

export function remainderModules(version: number): number[] {
  const b = new Builder(version);
  b.drawFunctionPatterns('L');
  return b.dataModuleOrder().slice(Math.floor(rawDataModules(version) / 8) * 8);
}

// ─────────────────────────── Data encoding ───────────────────────────

class BitBuffer {
  bits: number[] = [];
  append(value: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function buildDataCodewords(content: QrContent, version: number, ecc: EccLevel): Uint8Array {
  const bb = new BitBuffer();
  if (content.mode === 'byte') {
    bb.append(0b0100, 4);
    bb.append(content.bytes.length, version <= 9 ? 8 : 16);
    for (const b of content.bytes) bb.append(b, 8);
  } else {
    const t = content.text;
    bb.append(0b0010, 4);
    bb.append(t.length, version <= 9 ? 9 : version <= 26 ? 11 : 13);
    let i = 0;
    for (; i + 1 < t.length; i += 2) bb.append(ALNUM.indexOf(t[i]!) * 45 + ALNUM.indexOf(t[i + 1]!), 11);
    if (i < t.length) bb.append(ALNUM.indexOf(t[i]!), 6);
  }
  const capacityBits = dataCodewords(version, ecc) * 8;
  if (bb.bits.length > capacityBits) throw new QrCapacityError('data exceeds capacity');
  bb.append(0, Math.min(4, capacityBits - bb.bits.length)); // terminator
  bb.append(0, (8 - (bb.bits.length % 8)) % 8);
  for (let pad = 0xec; bb.bits.length < capacityBits; pad ^= 0xec ^ 0x11) bb.append(pad, 8);

  const out = new Uint8Array(bb.bits.length / 8);
  for (let i = 0; i < bb.bits.length; i++) out[i >>> 3]! |= bb.bits[i]! << (7 - (i & 7));
  return out;
}

function addEccAndInterleave(data: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const numBlocks = NUM_ECC_BLOCKS[ecc][version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version]!;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const divisor = rsDivisor(blockEccLen);
  const blocks: Uint8Array[] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.subarray(k, k + datLen);
    k += datLen;
    const block = new Uint8Array(shortBlockLen + 1);
    block.set(dat, 0);
    // Short blocks get a placeholder byte so all blocks align during interleaving.
    block.set(rsRemainder(dat, divisor), shortBlockLen + 1 - blockEccLen);
    blocks.push(block);
  }

  const result = new Uint8Array(rawCodewords);
  let o = 0;
  for (let i = 0; i < shortBlockLen + 1; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result[o++] = blocks[j]![i]!;
    }
  }
  return result;
}

// ─────────────────────────── Reed–Solomon over GF(2^8), poly 0x11D ───────────────────────────

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

export function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

export function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0]!;
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) result[i]! ^= gfMul(divisor[i]!, factor);
  }
  return result;
}

// ─────────────────────────── Matrix construction ───────────────────────────

export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

export function formatBits(ecc: EccLevel, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

class Builder {
  readonly size: number;
  readonly modules: Uint8Array;
  private readonly isFunction: Uint8Array;

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size);
    this.isFunction = new Uint8Array(this.size * this.size);
  }

  private setFn(x: number, y: number, dark: boolean): void {
    const i = y * this.size + x;
    this.modules[i] = dark ? 1 : 0;
    this.isFunction[i] = 1;
  }

  drawFunctionPatterns(ecc: EccLevel): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(n - 4, 3);
    this.drawFinder(3, n - 4);
    const pos = alignmentPositions(this.version);
    const last = pos.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        this.drawAlignment(pos[i]!, pos[j]!);
      }
    }
    this.drawFormatBits(ecc, 0); // reserve; overwritten after masking
    this.drawVersion();
  }

  private drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || xx >= this.size || yy < 0 || yy >= this.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.setFn(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFn(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  drawFormatBits(ecc: EccLevel, mask: number): void {
    const bits = formatBits(ecc, mask);
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.setFn(8, i, bit(i));
    this.setFn(8, 7, bit(6));
    this.setFn(8, 8, bit(7));
    this.setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFn(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFn(8, n - 15 + i, bit(i));
    this.setFn(8, n - 8, true); // dark module
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    const bits = versionBits(this.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFn(a, b, dark);
      this.setFn(b, a, dark);
    }
  }

  /** All non-function module indices in zigzag placement order. */
  dataModuleOrder(): number[] {
    const n = this.size;
    const order: number[] = [];
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const idx = (upward ? n - 1 - vert : vert) * n + (right - j);
          if (!this.isFunction[idx]) order.push(idx);
        }
      }
    }
    return order;
  }

  drawCodewords(data: Uint8Array): void {
    const order = this.dataModuleOrder();
    const totalBits = data.length * 8;
    for (let i = 0; i < totalBits; i++) this.modules[order[i]!] = (data[i >>> 3]! >>> (7 - (i & 7))) & 1;
  }

  applyMask(mask: number): void {
    const n = this.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const idx = y * n + x;
        if (!this.isFunction[idx] && maskInverts(mask, x, y)) this.modules[idx]! ^= 1;
      }
    }
  }

  /** ISO 18004 §7.8.3 penalty score (N1 runs, N2 blocks, N3 finder-like, N4 balance). */
  penalty(): number {
    const n = this.size;
    const m = this.modules;
    let score = 0;
    const lineScore = (get: (k: number) => number) => {
      let s = 0;
      let run = 1;
      for (let k = 1; k <= n; k++) {
        if (k < n && get(k) === get(k - 1)) run++;
        else {
          if (run >= 5) s += 3 + (run - 5);
          run = 1;
        }
      }
      // N3: 1:1:3:1:1 with 4 light modules on either side (outside the symbol counts as light).
      const at = (k: number) => (k < 0 || k >= n ? 0 : get(k));
      for (let k = -4; k < n; k++) {
        if (at(k + 4) && !at(k + 5) && at(k + 6) && at(k + 7) && at(k + 8) && !at(k + 9) && at(k + 10)) {
          const before = !at(k) && !at(k + 1) && !at(k + 2) && !at(k + 3);
          const after = !at(k + 11) && !at(k + 12) && !at(k + 13) && !at(k + 14);
          if (before || after) s += 40;
        }
      }
      return s;
    };
    for (let y = 0; y < n; y++) score += lineScore((k) => m[y * n + k]!);
    for (let x = 0; x < n; x++) score += lineScore((k) => m[k * n + x]!);
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = m[y * n + x];
        if (c === m[y * n + x + 1] && c === m[(y + 1) * n + x] && c === m[(y + 1) * n + x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (let i = 0; i < m.length; i++) dark += m[i]!;
    const total = n * n;
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return score;
  }
}
