import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { alignmentPositions, remainderModules, encodeQr, formatBits, QrCapacityError, rsDivisor, rsRemainder, versionBits, type QrMatrix } from '../src/qr/encoder.ts';
import { alphanumericCapacity, byteCapacity, ECC_LEVELS, type EccLevel } from '../src/qr/capacity.ts';

const hasCv2 = spawnSync('python3', ['-c', 'import cv2, numpy'], { stdio: 'ignore' }).status === 0;
const skip = !hasCv2 && 'python3/OpenCV not available';

function py(req: unknown): any {
  const r = spawnSync('python3', ['scripts/qr_reference.py'], { input: JSON.stringify(req), encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

const toBits = (m: QrMatrix) => Array.from(m.modules, (v) => (v ? '1' : '0')).join('');
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
function text(len: number, alphabet: string, seed: number): string {
  let s = '';
  let x = seed;
  for (let i = 0; i < len; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += alphabet[x % alphabet.length]; }
  return s;
}
const BYTE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-_.~!';

/** Read the mask from a matrix's primary format-information copy. */
function readMask(size: number, bits: string, ecc: EccLevel): number {
  const at = (x: number, y: number) => bits[y * size + x] === '1';
  let v = 0;
  const seq: boolean[] = [];
  for (let i = 0; i <= 5; i++) seq.push(at(8, i));
  seq.push(at(8, 7), at(8, 8), at(7, 8));
  for (let i = 9; i < 15; i++) seq.push(at(14 - i, 8));
  seq.forEach((b, i) => { if (b) v |= 1 << i; });
  for (let m = 0; m < 8; m++) if (formatBits(ecc, m) === v) return m;
  throw new Error('format bits not recognised');
}

test('Reed–Solomon: generator and remainder match the ISO 18004 Annex example', () => {
  // Version 1-M "01234567" example: data codewords → 10 EC codewords.
  const data = Uint8Array.from([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
  const ec = rsRemainder(data, rsDivisor(10));
  assert.deepEqual([...ec], [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
});

test('remainder bits: count per version matches the standard', () => {
  // ISO 18004 Table 1: 0 for v1, 7 for v2–6, 0 for v7–13, 3 for v14–20, 4 for v21–27, 3 for v28–34, 0 for v35–40.
  const expected = (v: number) => (v === 1 ? 0 : v <= 6 ? 7 : v <= 13 ? 0 : v <= 20 ? 3 : v <= 27 ? 4 : v <= 34 ? 3 : 0);
  for (let v = 1; v <= 40; v++) assert.equal(remainderModules(v).length, expected(v), `v${v}`);
});

test('format and version information BCH codes', () => {
  assert.equal(formatBits('M', 5), 0b100000011001110); // ISO 18004 example (M, mask 101)
  assert.equal(formatBits('L', 0), 0b111011111000100);
  assert.equal(versionBits(7), 0x07c94);
  assert.equal(versionBits(40), 0x28c69);
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(2), [6, 18]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

test('version selection, capacity errors and input validation', () => {
  const m = encodeQr({ mode: 'byte', bytes: new Uint8Array(17) }, { ecc: 'L' });
  assert.equal(m.version, 1);
  assert.equal(m.size, 21);
  assert.equal(encodeQr({ mode: 'byte', bytes: new Uint8Array(18) }, { ecc: 'L' }).version, 2);
  assert.equal(encodeQr({ mode: 'byte', bytes: new Uint8Array(5) }, { ecc: 'L', minVersion: 15 }).version, 15);
  assert.equal(encodeQr({ mode: 'byte', bytes: new Uint8Array(2953) }, { ecc: 'L' }).version, 40);
  assert.throws(() => encodeQr({ mode: 'byte', bytes: new Uint8Array(2954) }, { ecc: 'L' }), QrCapacityError);
  assert.throws(() => encodeQr({ mode: 'byte', bytes: new Uint8Array(300) }, { ecc: 'L', maxVersion: 5 }), QrCapacityError);
  assert.throws(() => encodeQr({ mode: 'alphanumeric', text: 'lowercase' }, { ecc: 'L' }), RangeError);
  assert.throws(() => encodeQr({ mode: 'byte', bytes: new Uint8Array(1) }, { ecc: 'L', mask: 8 }), RangeError);
});

test('module-for-module identical to OpenCV for all 40 versions × 4 ECC levels × 2 modes', { skip }, () => {
  // Where OpenCV's own output fails to decode (an OpenCV encoder bug), the reference is
  // not trusted; those cases are instead required to decode from OUR matrix.
  const cases: { version: number; ecc: EccLevel; mode: 'byte' | 'alphanumeric'; text: string }[] = [];
  for (let v = 1; v <= 40; v++) {
    for (const ecc of ECC_LEVELS) {
      // Full capacity for even versions, partial (exercises padding) for odd.
      const bl = v % 2 === 0 ? byteCapacity(v, ecc) : Math.max(1, Math.floor(byteCapacity(v, ecc) * 0.6));
      const al = v % 2 === 0 ? alphanumericCapacity(v, ecc) : Math.max(1, Math.floor(alphanumericCapacity(v, ecc) * 0.6) | 1);
      cases.push({ version: v, ecc, mode: 'byte', text: text(bl, BYTE_ALPHABET, v * 7 + bl) });
      cases.push({ version: v, ecc, mode: 'alphanumeric', text: text(al, ALNUM, v * 13 + al) });
    }
  }
  const refs: { size: number; bits: string; valid: boolean }[] = py({ op: 'encode', cases });
  assert.equal(refs.length, 320);
  const untrusted: { c: (typeof cases)[number]; m: QrMatrix }[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const ref = refs[i]!;
    const content = c.mode === 'byte' ? { mode: 'byte' as const, bytes: new TextEncoder().encode(c.text) } : { mode: 'alphanumeric' as const, text: c.text };
    if (!ref.valid) {
      untrusted.push({ c, m: encodeQr(content, { ecc: c.ecc, minVersion: c.version, maxVersion: c.version }) });
      continue;
    }
    const mask = readMask(ref.size, ref.bits, c.ecc);
    const ours = encodeQr(content, { ecc: c.ecc, minVersion: c.version, maxVersion: c.version, mask });
    assert.equal(ours.size, ref.size, `v${c.version}-${c.ecc} ${c.mode}: size`);
    // Remainder-bit modules carry no data; OpenCV does not always write them as 0.
    const ignore = new Set(remainderModules(c.version));
    const a = toBits(ours);
    const diffs: number[] = [];
    for (let k = 0; k < a.length; k++) if (a[k] !== ref.bits[k] && !ignore.has(k)) diffs.push(k);
    assert.deepEqual(diffs, [], `v${c.version}-${c.ecc} ${c.mode} mask ${mask}: modules differ`);
  }
  assert.ok(untrusted.length <= 16, `${untrusted.length} untrusted references`);
  if (untrusted.length) {
    const res: { cv: string | null; wechat: string | null }[] = py({ op: 'decode', matrices: untrusted.map((u) => ({ size: u.m.size, bits: toBits(u.m) })) });
    res.forEach((r, i) => {
      const { c } = untrusted[i]!;
      assert.ok(r.cv === c.text || r.wechat === c.text, `v${c.version}-${c.ecc} ${c.mode}: ours does not decode`);
    });
  }
  console.log(`# compared ${320 - untrusted.length} configurations module-for-module; ${untrusted.length} OpenCV references were invalid and checked by decoding instead`);
});

test('auto-masked output decodes with two independent decoders', { skip }, () => {
  const cases: { content: string; m: QrMatrix }[] = [];
  for (const v of [1, 2, 6, 7, 10, 14, 15, 20, 25, 27, 32, 40]) {
    for (const ecc of ECC_LEVELS) {
      const t = text(alphanumericCapacity(v, ecc), ALNUM, v + ecc.charCodeAt(0));
      cases.push({ content: t, m: encodeQr({ mode: 'alphanumeric', text: t }, { ecc, minVersion: v, maxVersion: v }) });
      const b = text(Math.floor(byteCapacity(v, ecc) / 2), BYTE_ALPHABET, v);
      cases.push({ content: b, m: encodeQr({ mode: 'byte', bytes: new TextEncoder().encode(b) }, { ecc, minVersion: v, maxVersion: v }) });
    }
  }
  const masks = new Set(cases.map((c) => c.m.mask));
  assert.ok(masks.size >= 5, 'mask selection varies');
  const res: { cv: string | null; wechat: string | null }[] = py({ op: 'decode', scale: 4, matrices: cases.map((c) => ({ size: c.m.size, bits: toBits(c.m) })) });
  res.forEach((r, i) => {
    const c = cases[i]!;
    assert.ok(r.cv === c.content || r.wechat === c.content, `v${c.m.version}-${c.m.ecc} mask ${c.m.mask} did not decode`);
  });
});
