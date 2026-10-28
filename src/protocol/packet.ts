/**
 * Binary packet codec — protocol v1.
 *
 * Every packet is   [header (headerLength bytes)][payload (payloadLength bytes)]
 * and the last 4 header bytes are a CRC-32 over the preceding header bytes.
 * Data payloads are protected separately by their SHA-256 chunk hash.
 *
 * Decoding is synchronous, allocation-free for payloads (subarray views), and
 * validates every length/offset/count *before* anything is allocated.
 * Chunk-hash verification is deliberately NOT done here: the receiver skips it
 * for known duplicates (spec §16) and must do it before storing anything else.
 */

import { crc32 } from '../crypto/crc32.ts';
import {
  COMMON_HEADER_BYTES,
  REPAIR_HEADER_BYTES,
  CRC_BYTES,
  DATA_HEADER_BYTES,
  DEFINED_FLAGS_MASK,
  HASH_BYTES,
  HashAlgorithm,
  MAGIC,
  MANIFEST_ENTRY_FIXED_BYTES,
  MANIFEST_FIXED_BYTES,
  MAX_MIME_BYTES,
  MAX_NAME_BYTES,
  PacketType,
  PROTOCOL_VERSION,
  SESSION_ID_BYTES,
  SUPPORTED_VERSIONS,
} from './constants.ts';
import { expectedChunkCount } from './chunking.ts';
import { MAX_REPAIR_BLOCK, symbolLength } from './fountain.ts';
import { ProtocolError } from './errors.ts';
import { DEFAULT_LIMITS, type ProtocolLimits } from './limits.ts';

// ───────────────────────────── Types ─────────────────────────────

export interface DataPacket {
  type: typeof PacketType.Data;
  version: number;
  sessionId: Uint8Array;
  fileId: number;
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  chunkIndex: number;
  startOffset: number;
  /** Exclusive; always startOffset + payload.length. */
  endOffset: number;
  fileHash: Uint8Array;
  chunkHash: Uint8Array;
  /** View into the decoded buffer — copy before retaining if the buffer is reused. */
  payload: Uint8Array;
}

export interface ManifestEntry {
  fileId: number;
  name: string;
  /** Empty string when unknown. */
  mimeType: string;
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  fileHash: Uint8Array;
}

export interface ManifestPacket {
  type: typeof PacketType.Manifest;
  version: number;
  sessionId: Uint8Array;
  partIndex: number;
  partCount: number;
  /** Total number of files in the session (across all parts). */
  fileCount: number;
  entries: ManifestEntry[];
}

/** Fountain repair symbol (PROTOCOL.md §5a). */
export interface RepairPacket {
  type: typeof PacketType.Repair;
  version: number;
  sessionId: Uint8Array;
  fileId: number;
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  blockIndex: number;
  /** Nominal chunks per source block for this file. */
  blockSize: number;
  symbolId: number;
  fileHash: Uint8Array;
  /** SHA-256 of the payload. */
  payloadHash: Uint8Array;
  /** XOR of the block's selected chunks, zero-padded to the block's first chunk length. View into the buffer. */
  payload: Uint8Array;
}

export type Packet = DataPacket | ManifestPacket | RepairPacket;

export interface RepairPacketInput {
  sessionId: Uint8Array;
  fileId: number;
  fileSize: number;
  chunkSize: number;
  blockIndex: number;
  blockSize: number;
  symbolId: number;
  fileHash: Uint8Array;
  payloadHash: Uint8Array;
  payload: Uint8Array;
}

export interface DataPacketInput {
  sessionId: Uint8Array;
  fileId: number;
  fileSize: number;
  chunkSize: number;
  chunkIndex: number;
  fileHash: Uint8Array;
  chunkHash: Uint8Array;
  payload: Uint8Array;
}

export interface ManifestPacketInput {
  sessionId: Uint8Array;
  partIndex: number;
  partCount: number;
  fileCount: number;
  entries: ManifestEntry[];
}

// ─────────────────────────── Helpers ───────────────────────────

const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function fail(reason: ConstructorParameters<typeof ProtocolError>[0], detail: string): never {
  throw new ProtocolError(reason, detail);
}

function assertU(n: number, bits: 8 | 16 | 32, what: string): void {
  const max = bits === 8 ? 0xff : bits === 16 ? 0xffff : 0xffffffff;
  if (!Number.isInteger(n) || n < 0 || n > max) throw new RangeError(`${what} must be a u${bits} (got ${n})`);
}

function writeU64(dv: DataView, off: number, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`u64 value must be a non-negative safe integer (got ${n})`);
  dv.setUint32(off, Math.floor(n / 0x100000000), false);
  dv.setUint32(off + 4, n >>> 0, false);
}

/** Returns -1 if the value exceeds Number.MAX_SAFE_INTEGER. */
function readU64(dv: DataView, off: number): number {
  const hi = dv.getUint32(off, false);
  const lo = dv.getUint32(off + 4, false);
  if (hi > 0x1fffff) return -1;
  return hi * 0x100000000 + lo;
}

function writeCommon(dv: DataView, out: Uint8Array, type: number, headerLength: number, payloadLength: number, sessionId: Uint8Array): void {
  if (sessionId.length !== SESSION_ID_BYTES) throw new RangeError(`sessionId must be ${SESSION_ID_BYTES} bytes`);
  dv.setUint16(0, MAGIC, false);
  dv.setUint8(2, PROTOCOL_VERSION);
  dv.setUint8(3, type);
  dv.setUint8(4, 0); // flags
  dv.setUint8(5, HashAlgorithm.Sha256);
  dv.setUint16(6, headerLength, false);
  dv.setUint16(8, payloadLength, false);
  out.set(sessionId, 10);
}

function sealHeader(out: Uint8Array, dv: DataView, headerLength: number): void {
  dv.setUint32(headerLength - CRC_BYTES, crc32(out, 0, headerLength - CRC_BYTES), false);
}

// ─────────────────────────── Encoding ───────────────────────────

export function encodeDataPacket(p: DataPacketInput): Uint8Array {
  assertU(p.fileId, 16, 'fileId');
  assertU(p.chunkSize, 32, 'chunkSize');
  if (p.chunkSize === 0) throw new RangeError('chunkSize must be > 0');
  if (p.fileHash.length !== HASH_BYTES || p.chunkHash.length !== HASH_BYTES) throw new RangeError('hashes must be 32 bytes');
  const chunkCount = expectedChunkCount(p.fileSize, p.chunkSize);
  assertU(chunkCount, 32, 'chunkCount');
  if (!Number.isInteger(p.chunkIndex) || p.chunkIndex < 0 || p.chunkIndex >= chunkCount) throw new RangeError('chunkIndex out of range');
  const start = p.chunkIndex * p.chunkSize;
  const expectedLen = Math.min(p.chunkSize, p.fileSize - start);
  if (p.payload.length !== expectedLen) throw new RangeError(`payload length ${p.payload.length} != expected ${expectedLen}`);
  assertU(p.payload.length, 16, 'payload length');

  const out = new Uint8Array(DATA_HEADER_BYTES + p.payload.length);
  const dv = new DataView(out.buffer);
  writeCommon(dv, out, PacketType.Data, DATA_HEADER_BYTES, p.payload.length, p.sessionId);
  let o = COMMON_HEADER_BYTES;
  dv.setUint16(o, p.fileId, false); o += 2;
  writeU64(dv, o, p.fileSize); o += 8;
  dv.setUint32(o, p.chunkSize, false); o += 4;
  dv.setUint32(o, chunkCount, false); o += 4;
  dv.setUint32(o, p.chunkIndex, false); o += 4;
  writeU64(dv, o, start); o += 8;
  out.set(p.fileHash, o); o += HASH_BYTES;
  out.set(p.chunkHash, o); o += HASH_BYTES;
  sealHeader(out, dv, DATA_HEADER_BYTES);
  out.set(p.payload, DATA_HEADER_BYTES);
  return out;
}

export function encodeRepairPacket(p: RepairPacketInput): Uint8Array {
  assertU(p.fileId, 16, 'fileId');
  assertU(p.chunkSize, 32, 'chunkSize');
  if (p.chunkSize === 0) throw new RangeError('chunkSize must be > 0');
  if (p.fileHash.length !== HASH_BYTES || p.payloadHash.length !== HASH_BYTES) throw new RangeError('hashes must be 32 bytes');
  const chunkCount = expectedChunkCount(p.fileSize, p.chunkSize);
  assertU(chunkCount, 32, 'chunkCount');
  if (!Number.isInteger(p.blockSize) || p.blockSize < 1 || p.blockSize > MAX_REPAIR_BLOCK) throw new RangeError(`blockSize must be 1..${MAX_REPAIR_BLOCK}`);
  if (!Number.isInteger(p.blockIndex) || p.blockIndex < 0 || p.blockIndex * p.blockSize >= chunkCount) throw new RangeError('blockIndex out of range');
  assertU(p.symbolId, 32, 'symbolId');
  const expectedLen = symbolLength(p.fileSize, p.chunkSize, p.blockSize, p.blockIndex);
  if (p.payload.length !== expectedLen) throw new RangeError(`payload length ${p.payload.length} != expected ${expectedLen}`);
  assertU(p.payload.length, 16, 'payload length');

  const out = new Uint8Array(REPAIR_HEADER_BYTES + p.payload.length);
  const dv = new DataView(out.buffer);
  writeCommon(dv, out, PacketType.Repair, REPAIR_HEADER_BYTES, p.payload.length, p.sessionId);
  let o = COMMON_HEADER_BYTES;
  dv.setUint16(o, p.fileId, false); o += 2;
  writeU64(dv, o, p.fileSize); o += 8;
  dv.setUint32(o, p.chunkSize, false); o += 4;
  dv.setUint32(o, chunkCount, false); o += 4;
  dv.setUint32(o, p.blockIndex, false); o += 4;
  dv.setUint32(o, p.blockSize, false); o += 4;
  dv.setUint32(o, p.symbolId, false); o += 4;
  out.set(p.fileHash, o); o += HASH_BYTES;
  out.set(p.payloadHash, o); o += HASH_BYTES;
  sealHeader(out, dv, REPAIR_HEADER_BYTES);
  out.set(p.payload, REPAIR_HEADER_BYTES);
  return out;
}

/** Encoded size of one manifest entry. */
export function manifestEntrySize(e: Pick<ManifestEntry, 'name' | 'mimeType'>): number {
  return MANIFEST_ENTRY_FIXED_BYTES + utf8.encode(e.mimeType).length + utf8.encode(e.name).length;
}

export function encodeManifestPacket(p: ManifestPacketInput): Uint8Array {
  assertU(p.partCount, 16, 'partCount');
  assertU(p.partIndex, 16, 'partIndex');
  assertU(p.fileCount, 16, 'fileCount');
  if (p.partCount === 0 || p.partIndex >= p.partCount) throw new RangeError('partIndex must be < partCount');
  if (p.entries.length === 0) throw new RangeError('manifest part must contain at least one entry');

  const encoded = p.entries.map((e) => {
    const name = utf8.encode(e.name);
    const mime = utf8.encode(e.mimeType);
    if (name.length === 0 || name.length > MAX_NAME_BYTES) throw new RangeError(`file name must be 1..${MAX_NAME_BYTES} UTF-8 bytes`);
    if (mime.length > MAX_MIME_BYTES) throw new RangeError(`mime type must be <= ${MAX_MIME_BYTES} bytes`);
    assertU(e.fileId, 16, 'fileId');
    assertU(e.chunkSize, 32, 'chunkSize');
    if (e.chunkCount !== expectedChunkCount(e.fileSize, e.chunkSize)) throw new RangeError('chunkCount inconsistent with fileSize/chunkSize');
    if (e.fileHash.length !== HASH_BYTES) throw new RangeError('fileHash must be 32 bytes');
    return { e, name, mime };
  });

  const headerLength = MANIFEST_FIXED_BYTES + encoded.reduce((n, x) => n + MANIFEST_ENTRY_FIXED_BYTES + x.name.length + x.mime.length, 0);
  assertU(headerLength, 16, 'manifest header length');
  const out = new Uint8Array(headerLength);
  const dv = new DataView(out.buffer);
  writeCommon(dv, out, PacketType.Manifest, headerLength, 0, p.sessionId);
  let o = COMMON_HEADER_BYTES;
  dv.setUint16(o, p.partIndex, false); o += 2;
  dv.setUint16(o, p.partCount, false); o += 2;
  dv.setUint16(o, p.fileCount, false); o += 2;
  dv.setUint16(o, encoded.length, false); o += 2;
  for (const { e, name, mime } of encoded) {
    dv.setUint16(o, e.fileId, false); o += 2;
    writeU64(dv, o, e.fileSize); o += 8;
    dv.setUint32(o, e.chunkSize, false); o += 4;
    dv.setUint32(o, e.chunkCount, false); o += 4;
    out.set(e.fileHash, o); o += HASH_BYTES;
    dv.setUint8(o, mime.length); o += 1;
    out.set(mime, o); o += mime.length;
    dv.setUint16(o, name.length, false); o += 2;
    out.set(name, o); o += name.length;
  }
  sealHeader(out, dv, headerLength);
  return out;
}

// ─────────────────────────── Decoding ───────────────────────────

/**
 * Parse and structurally validate a packet. Throws ProtocolError on any
 * violation. Does not verify the chunk hash (see module comment).
 */
export function decodePacket(buf: Uint8Array, limits: ProtocolLimits = DEFAULT_LIMITS): Packet {
  if (buf.length < COMMON_HEADER_BYTES + CRC_BYTES) fail('too-short', `${buf.length} bytes`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (dv.getUint16(0, false) !== MAGIC) fail('bad-magic', 'not an OptiSend packet');
  const version = dv.getUint8(2);
  if (!SUPPORTED_VERSIONS.includes(version)) fail('unsupported-version', `version ${version}`);
  const type = dv.getUint8(3);
  const flags = dv.getUint8(4);
  if ((flags & ~DEFINED_FLAGS_MASK) !== 0) fail('unsupported-flags', `flags 0x${flags.toString(16)}`);
  const hashAlg = dv.getUint8(5);
  if (hashAlg !== HashAlgorithm.Sha256) fail('unsupported-hash', `algorithm ${hashAlg}`);
  const headerLength = dv.getUint16(6, false);
  const payloadLength = dv.getUint16(8, false);

  if (headerLength > limits.maxHeaderLength) fail('header-too-large', `${headerLength} > ${limits.maxHeaderLength}`);
  if (payloadLength > limits.maxPayloadLength) fail('bad-payload-length', `${payloadLength} > ${limits.maxPayloadLength}`);
  if (headerLength + payloadLength !== buf.length) fail('length-mismatch', `header ${headerLength} + payload ${payloadLength} != packet ${buf.length}`);

  if (type === PacketType.Data) {
    if (headerLength !== DATA_HEADER_BYTES) fail('bad-header-length', `data header must be ${DATA_HEADER_BYTES}, got ${headerLength}`);
  } else if (type === PacketType.Repair) {
    if (headerLength !== REPAIR_HEADER_BYTES) fail('bad-header-length', `repair header must be ${REPAIR_HEADER_BYTES}, got ${headerLength}`);
  } else if (type === PacketType.Manifest) {
    if (headerLength < MANIFEST_FIXED_BYTES + MANIFEST_ENTRY_FIXED_BYTES + 1) fail('bad-header-length', `manifest header too short (${headerLength})`);
    if (payloadLength !== 0) fail('bad-payload-length', 'manifest packets carry no payload');
  } else {
    fail('unsupported-type', `packet type 0x${type.toString(16)}`);
  }

  const crcStored = dv.getUint32(headerLength - CRC_BYTES, false);
  if (crc32(buf, 0, headerLength - CRC_BYTES) !== crcStored) fail('header-crc', 'header checksum mismatch');

  const sessionId = buf.subarray(10, 10 + SESSION_ID_BYTES);
  if (type === PacketType.Data) return decodeData(buf, dv, version, sessionId, payloadLength, limits);
  if (type === PacketType.Repair) return decodeRepair(buf, dv, version, sessionId, payloadLength, limits);
  return decodeManifest(buf, dv, version, sessionId, headerLength, limits);
}

function validateGeometry(fileSize: number, chunkSize: number, chunkCount: number, limits: ProtocolLimits): void {
  if (fileSize < 0 || fileSize > limits.maxFileSize) fail('bad-file-size', `${fileSize} exceeds limit ${limits.maxFileSize}`);
  if (chunkSize === 0 || chunkSize > limits.maxPayloadLength) fail('bad-chunk-size', `chunk size ${chunkSize}`);
  if (chunkCount === 0 || chunkCount > limits.maxChunkCount) fail('bad-chunk-count', `chunk count ${chunkCount}`);
  if (chunkCount !== expectedChunkCount(fileSize, chunkSize)) fail('bad-chunk-count', `chunk count ${chunkCount} inconsistent with size ${fileSize} / ${chunkSize}`);
}

function decodeData(buf: Uint8Array, dv: DataView, version: number, sessionId: Uint8Array, payloadLength: number, limits: ProtocolLimits): DataPacket {
  let o = COMMON_HEADER_BYTES;
  const fileId = dv.getUint16(o, false); o += 2;
  const fileSize = readU64(dv, o); o += 8;
  const chunkSize = dv.getUint32(o, false); o += 4;
  const chunkCount = dv.getUint32(o, false); o += 4;
  const chunkIndex = dv.getUint32(o, false); o += 4;
  const startOffset = readU64(dv, o); o += 8;
  const fileHash = buf.subarray(o, o + HASH_BYTES); o += HASH_BYTES;
  const chunkHash = buf.subarray(o, o + HASH_BYTES); o += HASH_BYTES;

  if (fileSize < 0) fail('bad-file-size', 'file size exceeds 2^53');
  validateGeometry(fileSize, chunkSize, chunkCount, limits);
  if (chunkIndex >= chunkCount) fail('bad-chunk-index', `${chunkIndex} >= ${chunkCount}`);
  const expectedStart = chunkIndex * chunkSize;
  if (startOffset !== expectedStart) fail('bad-offset', `start ${startOffset} != ${expectedStart}`);
  const endOffset = startOffset + payloadLength;
  const expectedLen = Math.min(chunkSize, fileSize - startOffset);
  if (payloadLength !== expectedLen) fail('bad-payload-length', `payload ${payloadLength} != expected ${expectedLen}`);
  if (endOffset > fileSize) fail('bad-offset', `range [${startOffset}, ${endOffset}) exceeds file size ${fileSize}`);

  return {
    type: PacketType.Data,
    version,
    sessionId,
    fileId,
    fileSize,
    chunkSize,
    chunkCount,
    chunkIndex,
    startOffset,
    endOffset,
    fileHash,
    chunkHash,
    payload: buf.subarray(DATA_HEADER_BYTES, DATA_HEADER_BYTES + payloadLength),
  };
}

function decodeRepair(buf: Uint8Array, dv: DataView, version: number, sessionId: Uint8Array, payloadLength: number, limits: ProtocolLimits): RepairPacket {
  let o = COMMON_HEADER_BYTES;
  const fileId = dv.getUint16(o, false); o += 2;
  const fileSize = readU64(dv, o); o += 8;
  const chunkSize = dv.getUint32(o, false); o += 4;
  const chunkCount = dv.getUint32(o, false); o += 4;
  const blockIndex = dv.getUint32(o, false); o += 4;
  const blockSize = dv.getUint32(o, false); o += 4;
  const symbolId = dv.getUint32(o, false); o += 4;
  const fileHash = buf.subarray(o, o + HASH_BYTES); o += HASH_BYTES;
  const payloadHash = buf.subarray(o, o + HASH_BYTES); o += HASH_BYTES;

  if (fileSize < 0) fail('bad-file-size', 'file size exceeds 2^53');
  validateGeometry(fileSize, chunkSize, chunkCount, limits);
  if (blockSize === 0 || blockSize > MAX_REPAIR_BLOCK) fail('bad-block', `block size ${blockSize}`);
  if (blockIndex >= Math.ceil(chunkCount / blockSize)) fail('bad-block', `block ${blockIndex} beyond ${chunkCount} chunks of ${blockSize}`);
  const expectedLen = symbolLength(fileSize, chunkSize, blockSize, blockIndex);
  if (payloadLength !== expectedLen) fail('bad-payload-length', `repair payload ${payloadLength} != expected ${expectedLen}`);

  return {
    type: PacketType.Repair,
    version,
    sessionId,
    fileId,
    fileSize,
    chunkSize,
    chunkCount,
    blockIndex,
    blockSize,
    symbolId,
    fileHash,
    payloadHash,
    payload: buf.subarray(REPAIR_HEADER_BYTES, REPAIR_HEADER_BYTES + payloadLength),
  };
}

function decodeManifest(buf: Uint8Array, dv: DataView, version: number, sessionId: Uint8Array, headerLength: number, limits: ProtocolLimits): ManifestPacket {
  const end = headerLength - CRC_BYTES;
  let o = COMMON_HEADER_BYTES;
  const partIndex = dv.getUint16(o, false); o += 2;
  const partCount = dv.getUint16(o, false); o += 2;
  const fileCount = dv.getUint16(o, false); o += 2;
  const entryCount = dv.getUint16(o, false); o += 2;

  if (partCount === 0 || partIndex >= partCount) fail('bad-manifest', `part ${partIndex} of ${partCount}`);
  if (fileCount === 0 || fileCount > limits.maxFilesPerSession) fail('limit-exceeded', `file count ${fileCount}`);
  if (entryCount === 0 || entryCount > fileCount) fail('bad-manifest', `entry count ${entryCount} with file count ${fileCount}`);
  if (partCount > fileCount) fail('bad-manifest', `more parts (${partCount}) than files (${fileCount})`);

  const entries: ManifestEntry[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < entryCount; i++) {
    if (o + MANIFEST_ENTRY_FIXED_BYTES > end) fail('bad-manifest', `entry ${i} truncated`);
    const fileId = dv.getUint16(o, false); o += 2;
    const fileSize = readU64(dv, o); o += 8;
    const chunkSize = dv.getUint32(o, false); o += 4;
    const chunkCount = dv.getUint32(o, false); o += 4;
    const fileHash = buf.subarray(o, o + HASH_BYTES); o += HASH_BYTES;
    const mimeLen = dv.getUint8(o); o += 1;
    if (mimeLen > limits.maxMimeBytes) fail('bad-mime', `mime length ${mimeLen}`);
    if (o + mimeLen + 2 > end) fail('bad-manifest', `entry ${i} mime truncated`);
    const mimeBytes = buf.subarray(o, o + mimeLen); o += mimeLen;
    const nameLen = dv.getUint16(o, false); o += 2;
    if (nameLen === 0 || nameLen > limits.maxNameBytes) fail('bad-file-name', `name length ${nameLen}`);
    if (o + nameLen > end) fail('bad-manifest', `entry ${i} name truncated`);
    const nameBytes = buf.subarray(o, o + nameLen); o += nameLen;

    if (fileId >= fileCount) fail('bad-manifest', `file id ${fileId} >= file count ${fileCount}`);
    if (seen.has(fileId)) fail('bad-manifest', `duplicate file id ${fileId}`);
    seen.add(fileId);
    if (fileSize < 0) fail('bad-file-size', 'file size exceeds 2^53');
    validateGeometry(fileSize, chunkSize, chunkCount, limits);

    let name: string;
    let mimeType: string;
    try {
      name = utf8Strict.decode(nameBytes);
    } catch {
      fail('bad-file-name', 'file name is not valid UTF-8');
    }
    try {
      mimeType = utf8Strict.decode(mimeBytes);
    } catch {
      fail('bad-mime', 'mime type is not valid UTF-8');
    }
    entries.push({ fileId, name, mimeType, fileSize, chunkSize, chunkCount, fileHash: fileHash.slice() });
  }
  if (o !== end) fail('bad-manifest', `${end - o} trailing bytes`);

  return { type: PacketType.Manifest, version, sessionId, partIndex, partCount, fileCount, entries };
}
