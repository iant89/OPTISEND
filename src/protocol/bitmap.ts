/** Exact per-chunk received state (spec §3.5: the underlying map keeps every chunk). */
export class ChunkBitmap {
  private readonly bits: Uint8Array;
  private _count = 0;

  constructor(readonly size: number, bits?: Uint8Array) {
    if (!Number.isInteger(size) || size < 0) throw new RangeError('bitmap size must be a non-negative integer');
    const bytes = Math.ceil(size / 8);
    if (bits) {
      if (bits.length !== bytes) throw new RangeError('bitmap byte length mismatch');
      this.bits = bits.slice();
      for (let i = 0; i < size; i++) if (this.has(i)) this._count++;
    } else {
      this.bits = new Uint8Array(bytes);
    }
  }

  get count(): number {
    return this._count;
  }

  get complete(): boolean {
    return this._count === this.size;
  }

  has(i: number): boolean {
    return (this.bits[i >> 3]! & (1 << (i & 7))) !== 0;
  }

  /** Returns true if the bit was newly set. */
  set(i: number): boolean {
    this.check(i);
    if (this.has(i)) return false;
    this.bits[i >> 3]! |= 1 << (i & 7);
    this._count++;
    return true;
  }

  /** Returns true if the bit was previously set. */
  clear(i: number): boolean {
    this.check(i);
    if (!this.has(i)) return false;
    this.bits[i >> 3]! &= ~(1 << (i & 7));
    this._count--;
    return true;
  }

  *missing(): Generator<number> {
    for (let i = 0; i < this.size; i++) if (!this.has(i)) yield i;
  }

  /** Copy of the raw bits, e.g. for persistence. */
  toBytes(): Uint8Array {
    return this.bits.slice();
  }

  /**
   * Aggregate into `buckets` display segments, each the fraction (0..1) of its
   * chunks received — for rendering very large chunk counts (spec §3.5).
   */
  aggregate(buckets: number): Float32Array {
    const n = Math.max(1, Math.min(buckets, this.size || 1));
    const out = new Float32Array(n);
    if (this.size === 0) return out;
    for (let b = 0; b < n; b++) {
      const start = Math.floor((b * this.size) / n);
      const end = Math.floor(((b + 1) * this.size) / n);
      let c = 0;
      for (let i = start; i < end; i++) if (this.has(i)) c++;
      out[b] = end > start ? c / (end - start) : 0;
    }
    return out;
  }

  private check(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.size) throw new RangeError(`chunk index ${i} out of range`);
  }
}
