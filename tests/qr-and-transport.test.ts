import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesEqual } from '../src/crypto/bytes.ts';
import { chunkRange, expectedChunkCount } from '../src/protocol/chunking.ts';
import { DATA_HEADER_BYTES } from '../src/protocol/constants.ts';
import { sanitizeFileName, truncateFileName, utf8Length } from '../src/protocol/filename.ts';
import { frameForQr, framedLength, maxPacketForCapacity, unframeScan } from '../src/protocol/transport.ts';
import {
  alphanumericCapacity, byteCapacity, maxChunkPayload, maxPacketBytes, moduleCount, PAYLOAD_PRESETS, qrCapacity,
  smallestVersionFor, validateQrConfig, ECC_LEVELS,
} from '../src/qr/capacity.ts';
import { makeBytes } from './helpers.ts';

// ─── Chunk geometry ───

test('chunk counts and ranges', () => {
  assert.equal(expectedChunkCount(0, 10), 1);
  assert.equal(expectedChunkCount(1, 10), 1);
  assert.equal(expectedChunkCount(10, 10), 1);
  assert.equal(expectedChunkCount(11, 10), 2);
  assert.deepEqual(chunkRange(25, 10, 2), { index: 2, start: 20, end: 25, length: 5 });
  assert.deepEqual(chunkRange(0, 10, 0), { index: 0, start: 0, end: 0, length: 0 });
  assert.throws(() => chunkRange(25, 10, 3));
  assert.throws(() => expectedChunkCount(-1, 10));
  assert.throws(() => expectedChunkCount(10, 0));
});

test('chunk ranges tile the file exactly with no gaps or overlaps', () => {
  for (const [size, cs] of [[1, 1], [999, 100], [1000, 100], [12345, 2837]] as const) {
    let next = 0;
    for (let i = 0; i < expectedChunkCount(size, cs); i++) {
      const r = chunkRange(size, cs, i);
      assert.equal(r.start, next);
      assert.equal(r.end - r.start, r.length);
      next = r.end;
    }
    assert.equal(next, size);
  }
});

// ─── QR capacity ───

test('QR capacities match ISO 18004 reference values', () => {
  // Byte mode
  assert.equal(byteCapacity(1, 'L'), 17);
  assert.equal(byteCapacity(1, 'H'), 7);
  assert.equal(byteCapacity(10, 'M'), 213);
  assert.equal(byteCapacity(40, 'L'), 2953);
  assert.equal(byteCapacity(40, 'M'), 2331);
  assert.equal(byteCapacity(40, 'Q'), 1663);
  assert.equal(byteCapacity(40, 'H'), 1273);
  // Alphanumeric
  assert.equal(alphanumericCapacity(1, 'L'), 25);
  assert.equal(alphanumericCapacity(40, 'L'), 4296);
  assert.equal(alphanumericCapacity(40, 'H'), 1852);
  assert.equal(moduleCount(1), 21);
  assert.equal(moduleCount(40), 177);
});

test('capacity is monotonic in version and in ECC level', () => {
  for (const t of ['byte', 'alphanumeric'] as const) {
    for (const e of ECC_LEVELS) for (let v = 2; v <= 40; v++) assert.ok(qrCapacity(v, e, t) > qrCapacity(v - 1, e, t));
    for (let v = 1; v <= 40; v++) {
      assert.ok(qrCapacity(v, 'L', t) > qrCapacity(v, 'M', t));
      assert.ok(qrCapacity(v, 'M', t) > qrCapacity(v, 'Q', t));
      assert.ok(qrCapacity(v, 'Q', t) >= qrCapacity(v, 'H', t));
    }
  }
});

test('payload presets fit their QR symbol exactly', () => {
  for (const p of Object.values(PAYLOAD_PRESETS)) {
    assert.deepEqual(validateQrConfig(p), []);
    const packet = DATA_HEADER_BYTES + p.chunkSize;
    assert.ok(framedLength(packet, p.transport) <= qrCapacity(p.version, p.ecc, p.transport));
    assert.ok(framedLength(packet + 1, p.transport) > qrCapacity(p.version, p.ecc, p.transport));
    assert.equal(smallestVersionFor(packet, p.ecc, p.transport), p.version);
  }
  assert.equal(PAYLOAD_PRESETS['high-throughput'].chunkSize, 2953 - DATA_HEADER_BYTES);
});

test('alphanumeric (Base45) transport budget accounts for prefix and expansion', () => {
  const cap = alphanumericCapacity(40, 'L');
  const maxPkt = maxPacketBytes(40, 'L', 'alphanumeric');
  assert.equal(maxPkt, maxPacketForCapacity(cap, 'alphanumeric'));
  assert.ok(framedLength(maxPkt, 'alphanumeric') <= cap);
  assert.ok(framedLength(maxPkt + 1, 'alphanumeric') > cap);
  assert.equal(maxChunkPayload(40, 'L', 'alphanumeric'), maxPkt - DATA_HEADER_BYTES);
  // Tiny symbols cannot hold a data packet at all.
  assert.equal(maxChunkPayload(1, 'H', 'byte'), 0);
});

test('smallestVersionFor and validateQrConfig', () => {
  assert.equal(smallestVersionFor(17, 'L', 'byte'), 1);
  assert.equal(smallestVersionFor(18, 'L', 'byte'), 2);
  assert.equal(smallestVersionFor(2954, 'L', 'byte'), null);
  assert.deepEqual(validateQrConfig({ version: 20, ecc: 'M', transport: 'byte', chunkSize: 100 }), []);
  assert.equal(validateQrConfig({ version: 20, ecc: 'M', transport: 'byte', chunkSize: 5000 }).length, 1);
  assert.equal(validateQrConfig({ version: 41, ecc: 'M', transport: 'byte', chunkSize: 1 }).length, 1);
  assert.equal(validateQrConfig({ version: 5, ecc: 'M', transport: 'byte', chunkSize: 0 }).length, 1);
});

// ─── Transport framing ───

test('byte and alphanumeric framing round-trip', () => {
  const pkt = Uint8Array.from([0x4f, 0x53, 1, ...makeBytes(300)]);
  const b = frameForQr(pkt, 'byte');
  assert.equal(b.mode, 'byte');
  assert.ok(bytesEqual(unframeScan({ bytes: b.mode === 'byte' ? b.bytes : null })!, pkt));

  const a = frameForQr(pkt, 'alphanumeric');
  assert.equal(a.mode, 'alphanumeric');
  const text = a.mode === 'alphanumeric' ? a.text : '';
  assert.match(text, /^OS:[0-9A-Z $%*+\-./:]+$/);
  assert.equal(text.length, framedLength(pkt.length, 'alphanumeric'));
  assert.ok(bytesEqual(unframeScan({ text })!, pkt));
  // Decoder that hands back alphanumeric content as bytes.
  assert.ok(bytesEqual(unframeScan({ bytes: new TextEncoder().encode(text) })!, pkt));
  // Text-only decoder given byte-mode content (Latin-1 mapping).
  assert.ok(bytesEqual(unframeScan({ text: String.fromCharCode(...pkt) })!, pkt));
  // Plain arrays (jsQR binaryData is number[]).
  assert.ok(bytesEqual(unframeScan({ bytes: Array.from(pkt) })!, pkt));
});

test('foreign QR content is ignored', () => {
  assert.equal(unframeScan({ text: 'https://example.com' }), null);
  assert.equal(unframeScan({ bytes: new TextEncoder().encode('WIFI:S:x;;') }), null);
  assert.equal(unframeScan({ text: 'OS:abc' }), null); // lowercase is not Base45
  assert.equal(unframeScan({}), null);
});

// ─── File names ───

test('sanitizeFileName neutralises hostile names', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('C:\\Windows\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeFileName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(sanitizeFileName('bad\u0000name\u0007.txt'), 'bad_name_.txt');
  assert.equal(sanitizeFileName('invoice\u202Etxt.exe'), 'invoice_txt.exe'); // RTL override spoof
  assert.equal(sanitizeFileName('...hidden'), 'hidden');
  assert.equal(sanitizeFileName('trailing. . '), 'trailing');
  assert.equal(sanitizeFileName('CON'), '_CON');
  assert.equal(sanitizeFileName('lpt1.txt'), '_lpt1.txt');
  assert.equal(sanitizeFileName('', 'file-3'), 'file-3');
  assert.equal(sanitizeFileName('///'), 'file');
  assert.equal(sanitizeFileName('<script>alert(1)</script>.html'), 'script_.html');
  assert.equal(sanitizeFileName('normal name (1).pdf'), 'normal name (1).pdf');
});

test('truncateFileName keeps the extension and never splits a code point', () => {
  const long = 'é'.repeat(300) + '.pdf';
  const t = truncateFileName(long, 255);
  assert.ok(utf8Length(t) <= 255);
  assert.ok(t.endsWith('.pdf'));
  assert.ok(!t.includes('\uFFFD'));
  const emoji = '😀'.repeat(100);
  const e = truncateFileName(emoji, 10);
  assert.equal(e, '😀😀');
});
