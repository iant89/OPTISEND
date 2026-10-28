/**
 * Base45 (RFC 9285). Base45 text uses only the 45 characters of the QR
 * alphanumeric set, so a QR code encoded in alphanumeric mode carries it at
 * ~97% of byte-mode efficiency (16 bits per 16.5 encoded bits). Unlike byte
 * mode it survives decoders that only return normalised text strings (e.g.
 * the BarcodeDetector API's `rawValue`), which can mangle arbitrary bytes.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const LOOKUP = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export function base45Encode(data: Uint8Array): string {
  const parts: string[] = [];
  let i = 0;
  for (; i + 1 < data.length; i += 2) {
    let n = data[i]! * 256 + data[i + 1]!;
    const c = n % 45; n = (n - c) / 45;
    const d = n % 45; const e = (n - d) / 45;
    parts.push(ALPHABET[c]! + ALPHABET[d]! + ALPHABET[e]!);
  }
  if (i < data.length) {
    const n = data[i]!;
    const c = n % 45;
    parts.push(ALPHABET[c]! + ALPHABET[(n - c) / 45]!);
  }
  return parts.join('');
}

/** Returns null for any malformed input instead of throwing (scanner hot path). */
export function base45Decode(text: string): Uint8Array | null {
  const len = text.length;
  if (len % 3 === 1) return null;
  const out = new Uint8Array(Math.floor(len / 3) * 2 + (len % 3 === 2 ? 1 : 0));
  let o = 0;
  const val = (i: number): number => {
    const code = text.charCodeAt(i);
    return code < 128 ? LOOKUP[code]! : -1;
  };
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const c = val(i), d = val(i + 1), e = val(i + 2);
    if (c < 0 || d < 0 || e < 0) return null;
    const n = c + d * 45 + e * 2025;
    if (n > 0xffff) return null;
    out[o++] = n >> 8;
    out[o++] = n & 0xff;
  }
  if (i < len) {
    const c = val(i), d = val(i + 1);
    if (c < 0 || d < 0) return null;
    const n = c + d * 45;
    if (n > 0xff) return null;
    out[o++] = n;
  }
  return out;
}

/** Number of Base45 characters needed for `byteLength` bytes. */
export function base45Length(byteLength: number): number {
  return Math.floor(byteLength / 2) * 3 + (byteLength % 2) * 2;
}

/** Largest byte length whose Base45 encoding fits in `chars` characters. */
export function base45MaxBytes(chars: number): number {
  if (chars <= 0) return 0;
  return Math.floor(chars / 3) * 2 + (chars % 3 === 2 ? 1 : 0);
}
