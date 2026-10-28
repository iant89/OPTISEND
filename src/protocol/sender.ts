/**
 * Sender-side packetization (spec §5.1, §7, §8.2).
 *
 * `prepareTransfer` hashes each file once (streaming) and builds the manifest.
 * Data packets are produced lazily on demand — never all held in memory — by
 * reading the chunk from the source, hashing it and serializing it.
 */

import { sha256 } from '../crypto/sha256.ts';
import { randomBytes } from '../crypto/bytes.ts';
import { MANIFEST_FIXED_BYTES, MAX_MIME_BYTES, MAX_NAME_BYTES, SESSION_ID_BYTES } from './constants.ts';
import { chunkRange, expectedChunkCount } from './chunking.ts';
import { encodeDataPacket, encodeManifestPacket, encodeRepairPacket, manifestEntrySize, type ManifestEntry } from './packet.ts';
import { blockLayout, blockRange, coefficients, encodeRepairPayload, symbolLength } from './fountain.ts';
import { DEFAULT_LIMITS, type ProtocolLimits } from './limits.ts';
import { hashSource, type ByteSource } from './source.ts';
import { sanitizeFileName, truncateUtf8 } from './filename.ts';

export interface SendFileInput {
  name: string;
  mimeType?: string;
  source: ByteSource;
  /**
   * Precomputed SHA-256 of the whole source (e.g. from a hashing Web Worker or
   * a cache, so changing settings does not re-hash). Trusted as-is: a wrong
   * value makes every receiver reject the file at final verification.
   */
  fileHash?: Uint8Array;
}

export interface PrepareOptions {
  /** Chunk payload bytes; typically `maxChunkPayload(...)` or a preset's chunkSize. */
  chunkSize: number;
  /**
   * Target max size of each manifest packet (usually `maxPacketBytes(...)` for
   * the same QR config). An entry that cannot fit alone is emitted as its own
   * oversized part; the QR layer must then pick a larger version for it.
   */
  maxManifestPacketBytes: number;
  sessionId?: Uint8Array;
  limits?: ProtocolLimits;
  onHashProgress?: (fileIndex: number, hashedBytes: number, fileSize: number) => void;
  signal?: AbortSignal;
}

export interface PlannedFile extends ManifestEntry {
  source: ByteSource;
}

export type PacketRef = { kind: 'manifest'; part: number } | { kind: 'data'; fileId: number; chunkIndex: number };

export type ScheduleStrategy = 'sequential' | 'round-robin';

export interface PassOptions {
  strategy?: ScheduleStrategy;
  /** Re-insert the full manifest after every N data packets (0 = only at start). Default 50. */
  manifestEvery?: number;
}

export class SenderError extends Error {
  override name = 'SenderError';
}

/** Source blocks kept in memory for building repair symbols (bytes). */
const BLOCK_CACHE_BYTES = 32 * 1024 * 1024;

/** A repair symbol to send: which block of which file, and which symbol of it. */
export interface RepairRef {
  fileId: number;
  blockIndex: number;
  symbolId: number;
}

export class TransferPlan {
  private readonly blockCache = new Map<string, Uint8Array[]>();
  private blockCacheBytes = 0;

  constructor(
    readonly sessionId: Uint8Array,
    readonly files: readonly PlannedFile[],
    readonly manifestPackets: readonly Uint8Array[],
  ) {}

  get totalDataPackets(): number {
    return this.files.reduce((n, f) => n + f.chunkCount, 0);
  }

  get totalBytes(): number {
    return this.files.reduce((n, f) => n + f.fileSize, 0);
  }

  /** Number of QR frames in one pass for the given options. */
  packetsPerPass(opts: PassOptions = {}): number {
    let n = 0;
    for (const _ of this.pass(opts)) n++;
    return n;
  }

  async dataPacket(fileId: number, chunkIndex: number): Promise<Uint8Array> {
    const f = this.files[fileId];
    if (!f) throw new RangeError(`unknown fileId ${fileId}`);
    const r = chunkRange(f.fileSize, f.chunkSize, chunkIndex);
    const payload = await f.source.read(r.start, r.length);
    if (payload.length !== r.length) throw new SenderError(`short read for file ${fileId} chunk ${chunkIndex}`);
    return encodeDataPacket({
      sessionId: this.sessionId,
      fileId,
      fileSize: f.fileSize,
      chunkSize: f.chunkSize,
      chunkIndex,
      fileHash: f.fileHash,
      chunkHash: sha256(payload),
      payload,
    });
  }

  /**
   * The packet to show for `ref` in pass `pass`. With `fountain`, data frames of
   * pass 2 onwards become repair symbols (see repairRefFor): same frame count and
   * order, so schedules, estimates and colour grouping are unchanged.
   */
  async packet(ref: PacketRef, pass = 1, fountain = false): Promise<Uint8Array> {
    if (ref.kind === 'manifest') {
      const m = this.manifestPackets[ref.part];
      if (!m) throw new RangeError(`unknown manifest part ${ref.part}`);
      return m;
    }
    if (fountain && pass >= 2) {
      const r = this.repairRefFor(ref.fileId, ref.chunkIndex, pass);
      return this.repairPacket(r.fileId, r.blockIndex, r.symbolId);
    }
    return this.dataPacket(ref.fileId, ref.chunkIndex);
  }

  /**
   * In repair passes, the frame that carried chunk `chunkIndex` in pass 1 carries a
   * repair symbol of block (chunkIndex mod blockCount): consecutive frames cycle
   * through the blocks, so every block gets its share of repair symbols early in
   * the pass. Symbol ids never repeat across passes.
   */
  repairRefFor(fileId: number, chunkIndex: number, pass: number): RepairRef {
    const f = this.files[fileId];
    if (!f) throw new RangeError(`unknown fileId ${fileId}`);
    const { blockCount } = blockLayout(f.chunkCount);
    const slotsPerPass = Math.ceil(f.chunkCount / blockCount);
    return { fileId, blockIndex: chunkIndex % blockCount, symbolId: (pass - 2) * slotsPerPass + Math.floor(chunkIndex / blockCount) };
  }

  /** Build repair symbol `symbolId` of a block (PROTOCOL.md §5a). */
  async repairPacket(fileId: number, blockIndex: number, symbolId: number): Promise<Uint8Array> {
    const f = this.files[fileId];
    if (!f) throw new RangeError(`unknown fileId ${fileId}`);
    const { blockSize } = blockLayout(f.chunkCount);
    const chunks = await this.blockChunks(f, blockSize, blockIndex);
    const payload = encodeRepairPayload(chunks, coefficients(blockIndex, symbolId, chunks.length), symbolLength(f.fileSize, f.chunkSize, blockSize, blockIndex));
    return encodeRepairPacket({
      sessionId: this.sessionId,
      fileId,
      fileSize: f.fileSize,
      chunkSize: f.chunkSize,
      blockIndex,
      blockSize,
      symbolId: symbolId >>> 0,
      fileHash: f.fileHash,
      payloadHash: sha256(payload),
      payload,
    });
  }

  /** A block's chunks, read with one source read and cached (LRU by bytes). */
  private async blockChunks(f: PlannedFile, blockSize: number, blockIndex: number): Promise<Uint8Array[]> {
    const key = `${f.fileId}/${blockIndex}`;
    const hit = this.blockCache.get(key);
    if (hit) {
      this.blockCache.delete(key);
      this.blockCache.set(key, hit);
      return hit;
    }
    const { start, end } = blockRange(f.chunkCount, blockSize, blockIndex);
    const first = chunkRange(f.fileSize, f.chunkSize, start);
    const last = chunkRange(f.fileSize, f.chunkSize, end - 1);
    const bytes = await f.source.read(first.start, last.end - first.start);
    if (bytes.length !== last.end - first.start) throw new SenderError(`short read for file ${f.fileId} block ${blockIndex}`);
    const chunks: Uint8Array[] = [];
    for (let i = start; i < end; i++) {
      const r = chunkRange(f.fileSize, f.chunkSize, i);
      chunks.push(bytes.subarray(r.start - first.start, r.end - first.start));
    }
    this.blockCache.set(key, chunks);
    this.blockCacheBytes += bytes.length;
    for (const [k, v] of this.blockCache) {
      if (this.blockCacheBytes <= BLOCK_CACHE_BYTES || k === key) break;
      this.blockCache.delete(k);
      this.blockCacheBytes -= v.reduce((n, c) => n + c.length, 0);
    }
    return chunks;
  }

  /** One transmission pass: manifest, then every data packet, with periodic manifest repeats. */
  *pass(opts: PassOptions = {}): Generator<PacketRef> {
    const every = opts.manifestEvery ?? 50;
    const manifest = function* (this: TransferPlan): Generator<PacketRef> {
      for (let p = 0; p < this.manifestPackets.length; p++) yield { kind: 'manifest', part: p };
    }.bind(this);

    yield* manifest();
    let sinceManifest = 0;
    for (const ref of this.dataOrder(opts.strategy ?? 'sequential')) {
      if (every > 0 && sinceManifest === every) {
        yield* manifest();
        sinceManifest = 0;
      }
      yield ref;
      sinceManifest++;
    }
  }

  private *dataOrder(strategy: ScheduleStrategy): Generator<PacketRef> {
    if (strategy === 'sequential') {
      for (const f of this.files) for (let i = 0; i < f.chunkCount; i++) yield { kind: 'data', fileId: f.fileId, chunkIndex: i };
      return;
    }
    const max = Math.max(...this.files.map((f) => f.chunkCount));
    for (let i = 0; i < max; i++) for (const f of this.files) if (i < f.chunkCount) yield { kind: 'data', fileId: f.fileId, chunkIndex: i };
  }
}

export async function prepareTransfer(inputs: readonly SendFileInput[], opts: PrepareOptions): Promise<TransferPlan> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  if (inputs.length === 0) throw new SenderError('select at least one file');
  if (inputs.length > limits.maxFilesPerSession) throw new SenderError(`too many files (${inputs.length}); the limit is ${limits.maxFilesPerSession} per transfer`);
  if (!Number.isInteger(opts.chunkSize) || opts.chunkSize < 1 || opts.chunkSize > limits.maxPayloadLength) {
    throw new SenderError(`chunk size must be 1..${limits.maxPayloadLength} bytes (got ${opts.chunkSize})`);
  }
  const sessionId = opts.sessionId ?? randomBytes(SESSION_ID_BYTES);
  if (sessionId.length !== SESSION_ID_BYTES) throw new SenderError(`sessionId must be ${SESSION_ID_BYTES} bytes`);

  const files: PlannedFile[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const fileSize = input.source.size;
    if (fileSize > limits.maxFileSize) throw new SenderError(`"${input.name}" is ${fileSize} bytes; the maximum is ${limits.maxFileSize}`);
    const chunkCount = expectedChunkCount(fileSize, opts.chunkSize);
    if (chunkCount > limits.maxChunkCount) {
      throw new SenderError(`"${input.name}" needs ${chunkCount} QR codes; the maximum is ${limits.maxChunkCount}. Use a larger payload size.`);
    }
    if (input.fileHash && input.fileHash.length !== 32) throw new SenderError('fileHash must be 32 bytes');
    const fileHash =
      input.fileHash ??
      (await hashSource(input.source, {
        onProgress: (n) => opts.onHashProgress?.(i, n, fileSize),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }));
    files.push({
      fileId: i,
      name: sanitizeFileName(input.name, `file-${i + 1}`, Math.min(MAX_NAME_BYTES, limits.maxNameBytes)),
      mimeType: truncateUtf8((input.mimeType ?? '').trim(), Math.min(MAX_MIME_BYTES, limits.maxMimeBytes)),
      fileSize,
      chunkSize: opts.chunkSize,
      chunkCount,
      fileHash,
      source: input.source,
    });
  }

  return new TransferPlan(sessionId, files, buildManifestPackets(sessionId, files, opts.maxManifestPacketBytes));
}

/** Greedily pack manifest entries into as few parts as fit `maxPacketBytes`. */
export function buildManifestPackets(sessionId: Uint8Array, entries: readonly ManifestEntry[], maxPacketBytes: number): Uint8Array[] {
  const parts: ManifestEntry[][] = [];
  let current: ManifestEntry[] = [];
  let size = MANIFEST_FIXED_BYTES;
  for (const e of entries) {
    const s = manifestEntrySize(e);
    if (current.length > 0 && size + s > maxPacketBytes) {
      parts.push(current);
      current = [];
      size = MANIFEST_FIXED_BYTES;
    }
    current.push(e);
    size += s;
  }
  if (current.length > 0) parts.push(current);

  return parts.map((part, partIndex) =>
    encodeManifestPacket({
      sessionId,
      partIndex,
      partCount: parts.length,
      fileCount: entries.length,
      entries: part.map(({ fileId, name, mimeType, fileSize, chunkSize, chunkCount, fileHash }) => ({ fileId, name, mimeType, fileSize, chunkSize, chunkCount, fileHash })),
    }),
  );
}
