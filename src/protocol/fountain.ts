/**
 * Systematic fountain code over GF(2) for repair packets (type 0x03, docs/PROTOCOL.md §5a).
 *
 * The first pass sends every chunk as a data packet. Later passes send repair
 * symbols: each is the XOR of a pseudo-random subset of one source block's
 * chunks (shorter chunks zero-padded to the block's symbol length). Which chunks
 * a symbol combines is derived from (blockIndex, symbolId) by `coefficients`, so
 * nothing but the ids travels. A receiver missing m chunks of a block recovers
 * them from any m (occasionally a few more) repair symbols of that block by
 * Gaussian elimination, whichever symbols those are.
 */

import { chunkRange } from './chunking.ts';

/** Largest source block (chunks) a receiver accepts; bounds decode memory and work. */
export const MAX_REPAIR_BLOCK = 1024;
/** Source block size the sender aims for. */
export const DEFAULT_REPAIR_BLOCK = 256;

export interface BlockLayout {
  /** Nominal chunks per block (all blocks but the last have exactly this many). */
  blockSize: number;
  blockCount: number;
}

/** Split `chunkCount` chunks into the fewest blocks of at most `maxBlock`, as equal as possible. */
export function blockLayout(chunkCount: number, maxBlock = DEFAULT_REPAIR_BLOCK): BlockLayout {
  const blockCount = Math.ceil(chunkCount / maxBlock);
  const blockSize = Math.ceil(chunkCount / blockCount);
  return { blockSize, blockCount: Math.ceil(chunkCount / blockSize) };
}

/** Chunk index range [start, end) of a block. */
export function blockRange(chunkCount: number, blockSize: number, blockIndex: number): { start: number; end: number } {
  const start = blockIndex * blockSize;
  return { start, end: Math.min(start + blockSize, chunkCount) };
}

/** Bytes in every repair symbol of a block: its first (longest) chunk's length. */
export function symbolLength(fileSize: number, chunkSize: number, blockSize: number, blockIndex: number): number {
  return chunkRange(fileSize, chunkSize, blockIndex * blockSize).length;
}

/** MurmurHash3 finaliser: a well-mixed 32-bit value. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Which of a block's `n` chunks repair symbol `symbolId` combines, as a bitset
 * (bit j of word j>>5 = chunk j of the block). Normative (PROTOCOL.md §5a):
 *   base   = fmix32(fmix32(blockIndex XOR 0x9E3779B9) XOR symbolId)
 *   word w = fmix32((base + (w + 1) × 0x9E3779B9) mod 2^32)
 *   bits beyond n are cleared; if no bit is set, bit (symbolId mod n) is set.
 * Each chunk is included with probability 1/2. The generator must be non-linear
 * over GF(2) (fmix32 multiplies): with a linear one such as xorshift, every
 * symbol of a block would lie in one 32-dimensional subspace and no block with
 * more than 32 missing chunks could ever be solved.
 */
export function coefficients(blockIndex: number, symbolId: number, n: number): Uint32Array {
  const words = new Uint32Array(Math.ceil(n / 32));
  const base = fmix32(fmix32((blockIndex ^ 0x9e3779b9) >>> 0) ^ symbolId);
  for (let w = 0; w < words.length; w++) words[w] = fmix32((base + Math.imul(w + 1, 0x9e3779b9)) >>> 0);
  const tail = n & 31;
  if (tail) words[words.length - 1]! &= ((1 << tail) >>> 0) - 1;
  if (words.every((x) => x === 0)) {
    const j = symbolId % n;
    words[j >>> 5]! |= 1 << (j & 31);
  }
  return words;
}

export function hasBit(bits: Uint32Array, j: number): boolean {
  return ((bits[j >>> 5]! >>> (j & 31)) & 1) === 1;
}

/** dst ^= src over min(dst, src) bytes (src may be shorter: it is zero-padded). */
export function xorInto(dst: Uint8Array, src: Uint8Array): void {
  const n = Math.min(dst.length, src.length);
  let i = 0;
  // Word-at-a-time when both views are 4-byte aligned.
  if ((dst.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0) {
    const w = n >>> 2;
    const d32 = new Uint32Array(dst.buffer, dst.byteOffset, w);
    const s32 = new Uint32Array(src.buffer, src.byteOffset, w);
    for (; i < w; i++) d32[i]! ^= s32[i]!;
    i <<= 2;
  }
  for (; i < n; i++) dst[i]! ^= src[i]!;
}

/** Repair payload: XOR of the selected chunks of a block, each zero-padded to `length`. */
export function encodeRepairPayload(blockChunks: readonly Uint8Array[], coefs: Uint32Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let j = 0; j < blockChunks.length; j++) if (hasBit(coefs, j)) xorInto(out, blockChunks[j]!);
  return out;
}

/** One received repair symbol, reduced to the unknowns. */
export interface RepairEquation {
  coefs: Uint32Array;
  payload: Uint8Array;
}

/**
 * Solve for a block's missing chunks.
 *
 * @param n         chunks in the block
 * @param unknown   block-relative indices of the missing chunks
 * @param symbols   repair symbols (coefficients over all n chunks, payload)
 * @param known     block-relative index → chunk bytes, for every chunk not in `unknown`
 * @returns block-relative index → padded chunk bytes (symbol length), or null if the
 *          symbols do not yet determine every unknown (rank < unknown.length)
 */
export function solveBlock(
  n: number,
  unknown: readonly number[],
  symbols: readonly RepairEquation[],
  known: (j: number) => Uint8Array,
): Map<number, Uint8Array> | null {
  const m = unknown.length;
  if (m === 0) return new Map();
  if (symbols.length < m) return null;
  const col = new Map<number, number>(unknown.map((j, c) => [j, c]));
  const words = Math.ceil(m / 32);
  // Rows over the unknowns only; known chunks are XORed out of the right-hand side.
  const rows: { bits: Uint32Array; rhs: Uint8Array }[] = [];
  for (const s of symbols) {
    const bits = new Uint32Array(words);
    const rhs = s.payload.slice();
    for (let j = 0; j < n; j++) {
      if (!hasBit(s.coefs, j)) continue;
      const c = col.get(j);
      if (c === undefined) xorInto(rhs, known(j));
      else bits[c >>> 5]! |= 1 << (c & 31);
    }
    rows.push({ bits, rhs });
  }
  // Gauss–Jordan elimination: pivot each unknown column in turn.
  const pivotRow = new Array<number>(m).fill(-1);
  let next = 0;
  for (let c = 0; c < m; c++) {
    const w = c >>> 5, b = 1 << (c & 31);
    let p = -1;
    for (let r = next; r < rows.length; r++) if (rows[r]!.bits[w]! & b) { p = r; break; }
    if (p < 0) return null; // this unknown is not determined yet
    [rows[next], rows[p]] = [rows[p]!, rows[next]!];
    const pr = rows[next]!;
    for (let r = 0; r < rows.length; r++) {
      if (r === next || !(rows[r]!.bits[w]! & b)) continue;
      const row = rows[r]!;
      for (let k = 0; k < words; k++) row.bits[k]! ^= pr.bits[k]!;
      xorInto(row.rhs, pr.rhs);
    }
    pivotRow[c] = next++;
  }
  const out = new Map<number, Uint8Array>();
  for (let c = 0; c < m; c++) out.set(unknown[c]!, rows[pivotRow[c]!]!.rhs);
  return out;
}
