import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/crypto/crc32.ts';
import { sha256 } from '../src/crypto/sha256.ts';
import { bytesEqual } from '../src/crypto/bytes.ts';
import { DATA_HEADER_BYTES, MAGIC, PacketType } from '../src/protocol/constants.ts';
import { ProtocolError, type RejectReason } from '../src/protocol/errors.ts';
import { chunkRange, expectedChunkCount } from '../src/protocol/chunking.ts';
import { resolveLimits } from '../src/protocol/limits.ts';
import {
  decodePacket, encodeDataPacket, encodeManifestPacket, type DataPacket, type ManifestEntry, type ManifestPacket,
} from '../src/protocol/packet.ts';
import { makeBytes, SID } from './helpers.ts';

const FILE = makeBytes(1050, 42);
const FILE_HASH = sha256(FILE);

function dataPacket(index: number, chunkSize = 100, file = FILE): Uint8Array {
  const r = chunkRange(file.length, chunkSize, index);
  const payload = file.subarray(r.start, r.end);
  return encodeDataPacket({ sessionId: SID, fileId: 3, fileSize: file.length, chunkSize, chunkIndex: index, fileHash: sha256(file), chunkHash: sha256(payload), payload });
}

const ENTRY: ManifestEntry = { fileId: 0, name: 'report.pdf', mimeType: 'application/pdf', fileSize: 1050, chunkSize: 100, chunkCount: 11, fileHash: FILE_HASH };

function manifest(entries: ManifestEntry[] = [ENTRY], fileCount = entries.length): Uint8Array {
  return encodeManifestPacket({ sessionId: SID, partIndex: 0, partCount: 1, fileCount, entries });
}

/** Re-seal the header CRC after a deliberate mutation, so validation reaches deeper checks. */
function reseal(buf: Uint8Array): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const hl = dv.getUint16(6, false);
  dv.setUint32(hl - 4, crc32(buf, 0, hl - 4), false);
  return buf;
}

function mutate(buf: Uint8Array, fn: (dv: DataView, b: Uint8Array) => void, resealCrc = true): Uint8Array {
  const b = buf.slice();
  fn(new DataView(b.buffer), b);
  return resealCrc ? reseal(b) : b;
}

function rejects(buf: Uint8Array, reason: RejectReason, limits = resolveLimits()): void {
  assert.throws(() => decodePacket(buf, limits), (e: unknown) => e instanceof ProtocolError && e.reason === reason, `expected ${reason}`);
}

// ─── Round trips ───

test('data packet round-trips every field; header is 116 bytes', () => {
  const buf = dataPacket(4);
  assert.equal(buf.length, DATA_HEADER_BYTES + 100);
  const p = decodePacket(buf) as DataPacket;
  assert.equal(p.type, PacketType.Data);
  assert.equal(p.version, 1);
  assert.ok(bytesEqual(p.sessionId, SID));
  assert.equal(p.fileId, 3);
  assert.equal(p.fileSize, 1050);
  assert.equal(p.chunkSize, 100);
  assert.equal(p.chunkCount, 11);
  assert.equal(p.chunkIndex, 4);
  assert.equal(p.startOffset, 400);
  assert.equal(p.endOffset, 500);
  assert.ok(bytesEqual(p.fileHash, FILE_HASH));
  assert.ok(bytesEqual(p.payload, FILE.subarray(400, 500)));
  assert.ok(bytesEqual(p.chunkHash, sha256(p.payload)));
});

test('header layout is big-endian with "OS" magic', () => {
  const buf = dataPacket(0);
  assert.equal((buf[0]! << 8) | buf[1]!, MAGIC);
  assert.equal(buf[0], 0x4f);
  assert.equal(buf[1], 0x53);
  const dv = new DataView(buf.buffer);
  assert.equal(dv.getUint16(6, false), 116);
  assert.equal(dv.getUint16(8, false), 100);
});

test('last chunk is short; offsets satisfy end - start = length (spec §6.3)', () => {
  const p = decodePacket(dataPacket(10)) as DataPacket;
  assert.equal(p.startOffset, 1000);
  assert.equal(p.endOffset, 1050);
  assert.equal(p.payload.length, 50);
  assert.equal(p.endOffset - p.startOffset, p.payload.length);
});

test('empty file is one zero-length chunk', () => {
  const empty = new Uint8Array(0);
  assert.equal(expectedChunkCount(0, 100), 1);
  const buf = encodeDataPacket({ sessionId: SID, fileId: 0, fileSize: 0, chunkSize: 100, chunkIndex: 0, fileHash: sha256(empty), chunkHash: sha256(empty), payload: empty });
  const p = decodePacket(buf) as DataPacket;
  assert.equal(p.chunkCount, 1);
  assert.equal(p.payload.length, 0);
  assert.equal(p.endOffset, 0);
});

test('file sizes beyond 2^32 encode and decode exactly', () => {
  const fileSize = 2 ** 33 + 123;
  const chunkSize = 2800;
  const lastIndex = expectedChunkCount(fileSize, chunkSize) - 1;
  const r = chunkRange(fileSize, chunkSize, lastIndex);
  const payload = makeBytes(r.length);
  const buf = encodeDataPacket({ sessionId: SID, fileId: 0, fileSize, chunkSize, chunkIndex: lastIndex, fileHash: FILE_HASH, chunkHash: sha256(payload), payload });
  const p = decodePacket(buf, resolveLimits({ maxFileSize: 2 ** 40 })) as DataPacket;
  assert.equal(p.fileSize, fileSize);
  assert.equal(p.startOffset, r.start);
  assert.equal(p.endOffset, fileSize);
});

test('manifest round-trips multiple entries including UTF-8 names', () => {
  const e2: ManifestEntry = { fileId: 1, name: 'résumé — 日本.txt', mimeType: '', fileSize: 0, chunkSize: 100, chunkCount: 1, fileHash: sha256(new Uint8Array()) };
  const m = decodePacket(manifest([ENTRY, e2])) as ManifestPacket;
  assert.equal(m.type, PacketType.Manifest);
  assert.equal(m.fileCount, 2);
  assert.equal(m.entries.length, 2);
  assert.deepEqual({ ...m.entries[0]!, fileHash: null }, { ...ENTRY, fileHash: null });
  assert.equal(m.entries[1]!.name, 'résumé — 日本.txt');
  assert.equal(m.entries[1]!.mimeType, '');
});

// ─── Rejections (spec §6.6) ───

test('rejects truncated / garbage input', () => {
  rejects(new Uint8Array(0), 'too-short');
  rejects(new Uint8Array(21), 'too-short');
  rejects(new TextEncoder().encode('https://example.com/not-a-packet'), 'bad-magic');
});

test('rejects unsupported version, type, flags and hash algorithm', () => {
  rejects(mutate(dataPacket(0), (dv) => dv.setUint8(2, 2)), 'unsupported-version');
  rejects(mutate(dataPacket(0), (dv) => dv.setUint8(2, 0)), 'unsupported-version');
  rejects(mutate(dataPacket(0), (dv) => dv.setUint8(3, 0x04)), 'unsupported-type');
  rejects(mutate(dataPacket(0), (dv) => dv.setUint8(3, 0x7f)), 'unsupported-type');
  rejects(mutate(dataPacket(0), (dv) => dv.setUint8(4, 0x01)), 'unsupported-flags');
  rejects(mutate(dataPacket(0), (dv) => dv.setUint8(5, 2)), 'unsupported-hash');
});

test('rejects inconsistent header / payload lengths', () => {
  rejects(dataPacket(0).subarray(0, 150), 'length-mismatch');
  const extended = new Uint8Array(dataPacket(0).length + 1);
  extended.set(dataPacket(0));
  rejects(extended, 'length-mismatch');
  rejects(mutate(dataPacket(0), (dv) => dv.setUint16(6, 117, false), false), 'length-mismatch');
  // Header length changed consistently with buffer but wrong for the type.
  const b = new Uint8Array(dataPacket(0).length + 8);
  b.set(dataPacket(0));
  rejects(mutate(b, (dv) => dv.setUint16(6, 124, false)), 'bad-header-length');
});

test('rejects any header corruption via CRC', () => {
  const good = dataPacket(3);
  for (let i = 0; i < DATA_HEADER_BYTES; i++) {
    const b = good.slice();
    b[i]! ^= 0x10;
    assert.throws(() => decodePacket(b), ProtocolError, `byte ${i}`);
  }
});

test('payload corruption passes structural decode (caught by chunk hash in the receiver)', () => {
  const b = dataPacket(3);
  b[DATA_HEADER_BYTES + 5]! ^= 0xff;
  const p = decodePacket(b) as DataPacket;
  assert.ok(!bytesEqual(sha256(p.payload), p.chunkHash));
});

test('rejects invalid geometry: chunk count, index, offset, payload length, file size', () => {
  rejects(mutate(dataPacket(0), (dv) => dv.setUint32(32, 12, false)), 'bad-chunk-count');
  rejects(mutate(dataPacket(0), (dv) => dv.setUint32(32, 0, false)), 'bad-chunk-count');
  rejects(mutate(dataPacket(0), (dv) => dv.setUint32(36, 11, false)), 'bad-chunk-index');
  rejects(mutate(dataPacket(2), (dv) => dv.setUint32(44, 201, false)), 'bad-offset');
  rejects(mutate(dataPacket(0), (dv) => dv.setUint32(28, 0, false)), 'bad-chunk-size');
  // Chunk size changed so declared chunk count no longer matches.
  rejects(mutate(dataPacket(0), (dv) => dv.setUint32(28, 95, false)), 'bad-chunk-count');
  // File size > 2^53.
  rejects(mutate(dataPacket(0), (dv) => dv.setUint32(20, 0x00200000, false)), 'bad-file-size');
  // Last chunk claiming a full-length payload: payload length != expected.
  const full = makeBytes(1100, 42);
  const r = chunkRange(1100, 100, 10);
  const last = encodeDataPacket({ sessionId: SID, fileId: 3, fileSize: 1100, chunkSize: 100, chunkIndex: 10, fileHash: FILE_HASH, chunkHash: sha256(full.subarray(r.start, r.end)), payload: full.subarray(r.start, r.end) });
  rejects(mutate(last, (dv) => { dv.setUint32(24, 1050, false); dv.setUint32(32, 11, false); }), 'bad-payload-length');
});

test('enforces configurable limits before allocation (spec §12.3)', () => {
  rejects(dataPacket(0), 'bad-file-size', resolveLimits({ maxFileSize: 1000 }));
  rejects(dataPacket(0), 'bad-chunk-count', resolveLimits({ maxChunkCount: 10 }));
  rejects(dataPacket(0), 'bad-payload-length', resolveLimits({ maxPayloadLength: 99 }));
  rejects(manifest(), 'header-too-large', resolveLimits({ maxHeaderLength: 50 }));
  const longName = { ...ENTRY, name: 'x'.repeat(200) };
  rejects(manifest([longName]), 'bad-file-name', resolveLimits({ maxNameBytes: 100 }));
  rejects(manifest(), 'limit-exceeded', resolveLimits({ maxFilesPerSession: 0 }));
});

test('manifest validation: duplicate ids, id >= count, bad parts, invalid UTF-8, trailing bytes', () => {
  rejects(manifest([ENTRY, ENTRY]), 'bad-manifest'); // duplicate id 0
  rejects(manifest([{ ...ENTRY, fileId: 5 }], 2), 'bad-manifest'); // id >= fileCount
  rejects(mutate(manifest(), (dv) => dv.setUint16(18, 1, false)), 'bad-manifest'); // partIndex == partCount
  rejects(mutate(manifest(), (dv) => dv.setUint16(20, 0, false)), 'bad-manifest'); // partCount 0
  rejects(mutate(manifest(), (dv) => dv.setUint16(24, 0, false)), 'bad-manifest'); // entryCount 0
  rejects(mutate(manifest(), (dv) => dv.setUint16(22, 0, false)), 'limit-exceeded'); // fileCount 0
  // Invalid UTF-8 in the name: first name byte is at the end of the header, before the CRC.
  const m = manifest();
  const nameStart = m.length - 4 - ENTRY.name.length;
  rejects(mutate(m, (_dv, b) => { b[nameStart] = 0xff; }), 'bad-file-name');
  // Inconsistent geometry inside an entry.
  // Entries start at byte 26: fileId(2) fileSize(8) chunkSize(4) chunkCount(4)…
  rejects(mutate(m, (dv) => dv.setUint32(26 + 2 + 8 + 4, 12, false)), 'bad-chunk-count');
});

test('manifest packets must not carry a payload', () => {
  const m = manifest();
  const b = new Uint8Array(m.length + 3);
  b.set(m);
  rejects(mutate(b, (dv) => dv.setUint16(8, 3, false)), 'bad-payload-length');
});

test('encoder refuses to build invalid packets', () => {
  const payload = FILE.subarray(0, 100);
  const base = { sessionId: SID, fileId: 0, fileSize: 1050, chunkSize: 100, chunkIndex: 0, fileHash: FILE_HASH, chunkHash: sha256(payload), payload };
  assert.throws(() => encodeDataPacket({ ...base, chunkIndex: 11 }));
  assert.throws(() => encodeDataPacket({ ...base, payload: FILE.subarray(0, 99) }));
  assert.throws(() => encodeDataPacket({ ...base, sessionId: new Uint8Array(4) }));
  assert.throws(() => encodeDataPacket({ ...base, fileId: 70000 }));
  assert.throws(() => encodeManifestPacket({ sessionId: SID, partIndex: 0, partCount: 1, fileCount: 1, entries: [] }));
  assert.throws(() => encodeManifestPacket({ sessionId: SID, partIndex: 0, partCount: 1, fileCount: 1, entries: [{ ...ENTRY, name: '' }] }));
  assert.throws(() => encodeManifestPacket({ sessionId: SID, partIndex: 0, partCount: 1, fileCount: 1, entries: [{ ...ENTRY, chunkCount: 3 }] }));
});

test('fuzz: random and mutated inputs only ever throw ProtocolError', () => {
  const seeds = [dataPacket(0), dataPacket(10), manifest()];
  let x = 12345;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x);
  for (let iter = 0; iter < 5000; iter++) {
    let b: Uint8Array;
    if (iter % 5 === 0) {
      b = makeBytes(rnd() % 400, iter + 1);
    } else {
      b = seeds[iter % seeds.length]!.slice();
      const flips = 1 + (rnd() % 4);
      for (let k = 0; k < flips; k++) b[rnd() % b.length] = rnd() & 0xff;
      // Re-seal a third of them so mutations get past the CRC into deeper validation.
      const hl = b.length >= 10 ? new DataView(b.buffer).getUint16(6, false) : 0;
      if (iter % 3 === 0 && hl >= 8 && hl <= b.length) reseal(b);
    }
    try {
      decodePacket(b);
    } catch (e) {
      assert.ok(e instanceof ProtocolError, `iteration ${iter}: ${String(e)}`);
    }
  }
});
