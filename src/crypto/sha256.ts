/**
 * Pure TypeScript SHA-256 (FIPS 180-4) with an incremental API.
 *
 * Why not WebCrypto? `crypto.subtle.digest` is one-shot only, so hashing a
 * multi-gigabyte file would require holding it in one contiguous buffer.
 * This implementation streams with bounded memory, runs synchronously (handy
 * inside Web Workers and the receiver's hot path), and has no dependencies.
 * Correctness is cross-checked against node:crypto in the test suite.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

export const SHA256_BYTES = 32;

export class Sha256 {
  private readonly h = new Uint32Array(IV);
  private readonly w = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  /** Total bytes processed. A JS number is exact up to 2^53 bytes (8 PiB). */
  private total = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error('Sha256: update() after digest()');
    let pos = 0;
    const len = data.length;
    this.total += len;

    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, len);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      pos = take;
      if (this.blockLen < 64) return this;
      this.compress(this.block, 0);
      this.blockLen = 0;
    }
    while (len - pos >= 64) {
      this.compress(data, pos);
      pos += 64;
    }
    if (pos < len) {
      this.block.set(data.subarray(pos), 0);
      this.blockLen = len - pos;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error('Sha256: digest() called twice');
    this.finished = true;
    const bitLenHi = Math.floor(this.total / 0x20000000); // total*8 / 2^32
    const bitLenLo = (this.total * 8) >>> 0;

    const b = this.block;
    b[this.blockLen++] = 0x80;
    if (this.blockLen > 56) {
      b.fill(0, this.blockLen);
      this.compress(b, 0);
      this.blockLen = 0;
    }
    b.fill(0, this.blockLen, 56);
    const dv = new DataView(b.buffer, b.byteOffset, 64);
    dv.setUint32(56, bitLenHi, false);
    dv.setUint32(60, bitLenLo, false);
    this.compress(b, 0);

    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, this.h[i]!, false);
    return out;
  }

  private compress(data: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    const h = this.h;
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
}

/** One-shot SHA-256. */
export function sha256(data: Uint8Array): Uint8Array {
  return new Sha256().update(data).digest();
}
