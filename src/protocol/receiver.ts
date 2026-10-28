/**
 * Receiver engine (spec §2.2, §6.4–6.6, §7, §9.4). UI-agnostic: feed it the
 * packet bytes recovered from each QR scan via `ingest()`.
 *
 * Guarantees (spec §15.4):
 *  - A chunk counts only after its SHA-256 matches AND the store write succeeds.
 *  - Duplicates never change state or progress; known duplicates skip hashing.
 *  - A conflicting packet never overwrites validated data.
 *  - Chunks are isolated by session + file id + index; names are never keys.
 *  - A file is `verified` only after the reassembled bytes match the full-file hash.
 */

import { bytesEqual, toHex } from '../crypto/bytes.ts';
import { Sha256, sha256 } from '../crypto/sha256.ts';
import { ChunkBitmap } from './bitmap.ts';
import { chunkRange } from './chunking.ts';
import type { ChunkStore } from './chunk-store.ts';
import { PacketType } from './constants.ts';
import { ProtocolError, type RejectReason } from './errors.ts';
import { sanitizeFileName } from './filename.ts';
import { resolveLimits, type ProtocolLimits } from './limits.ts';
import { decodePacket, type DataPacket, type ManifestPacket, type RepairPacket } from './packet.ts';
import { blockRange, coefficients, solveBlock } from './fountain.ts';

// ───────────────────────────── Types ─────────────────────────────

export type FileStatus = 'receiving' | 'verifying' | 'verified' | 'hash-mismatch';

export type IngestResult =
  | { status: 'accepted'; sessionId: string; fileId: number; chunkIndex: number; fileStatus: FileStatus }
  | { status: 'duplicate'; sessionId: string; fileId?: number; chunkIndex?: number }
  | { status: 'manifest'; sessionId: string; part: number; newFiles: number }
  | { status: 'conflict'; sessionId: string; fileId?: number; chunkIndex?: number; detail: string }
  | { status: 'rejected'; reason: RejectReason; detail: string }
  | { status: 'storage-error'; sessionId: string; fileId: number; chunkIndex: number; detail: string }
  /** A repair symbol was kept; `recovered` chunks were rebuilt from repair symbols because of it. */
  | { status: 'repair'; sessionId: string; fileId: number; blockIndex: number; recovered: number; fileStatus: FileStatus };

export interface ReceiverStats {
  packetsSeen: number;
  accepted: number;
  duplicates: number;
  manifests: number;
  rejected: number;
  conflicts: number;
  storageFailures: number;
  /** Repair symbols kept for decoding. */
  repairSymbols: number;
  /** Chunks rebuilt from repair symbols. */
  recoveredChunks: number;
  rejectReasons: Partial<Record<RejectReason, number>>;
}

/** Repair symbols kept per block beyond the number of missing chunks (rank slack). */
export const REPAIR_SLACK = 8;
/** Memory for buffered repair symbols across all files (bytes). Further symbols are dropped until it frees up. */
export const MAX_REPAIR_BYTES = 64 * 1024 * 1024;

interface BlockRepair {
  /** symbolId → payload (verified against its hash), oldest first. */
  symbols: Map<number, Uint8Array>;
  solving: boolean;
}

export interface FileSnapshot {
  sessionId: string;
  fileId: number;
  /** Sender-declared name (untrusted, may be null before the manifest arrives). */
  name: string | null;
  /** Safe name for display/download. */
  displayName: string;
  mimeType: string | null;
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  receivedChunks: number;
  missingChunks: number;
  /** Unique bytes whose chunk hash matched and whose write succeeded. */
  storedBytes: number;
  /** 0..1, from unique stored bytes (chunk-based for empty files). */
  progress: number;
  status: FileStatus;
  hasManifest: boolean;
  conflicts: number;
  rejectedChunks: number;
  lastActivity: number;
  timing: FileTiming;
}

/**
 * Per-file transfer timing. The clock starts when the file's first chunk is
 * captured and stops when the file is verified; it only runs while the
 * receiver is actively scanning (see ReceiverEngine.setReceiving), so pauses,
 * a closed page or a reload gap are not counted.
 */
export interface FileTiming {
  /** Wall-clock time of the first captured chunk (null until then). */
  startedAt: number | null;
  /** Wall-clock time the file was verified (null until then). */
  verifiedAt: number | null;
  /** Active receiving time so far, ms. */
  elapsedMs: number;
  /**
   * Bytes per second: final (fileSize / elapsed) once verified, live
   * (stored bytes / elapsed) while receiving. Null when not meaningful
   * (nothing yet, under ~1 s of data, or an empty / single-capture file).
   */
  bytesPerSecond: number | null;
}

export interface SessionSnapshot {
  sessionId: string;
  /** From the manifest; null until any manifest part is seen. */
  declaredFileCount: number | null;
  manifestPartsSeen: number;
  manifestPartCount: number | null;
  /** True once every declared file is known (manifest or data). */
  allFilesKnown: boolean;
  files: FileSnapshot[];
  totalBytes: number;
  storedBytes: number;
  progress: number;
  /** All declared files verified. */
  complete: boolean;
  lastActivity: number;
}

interface FileState {
  sessionId: string;
  fileId: number;
  name: string | null;
  mimeType: string | null;
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  fileHash: Uint8Array;
  bitmap: ChunkBitmap;
  /** First 4 bytes of each validated chunk's hash — detects conflicting duplicates without rehashing. */
  fingerprints: Uint32Array;
  pending: Set<number>;
  storedBytes: number;
  status: FileStatus;
  hasManifest: boolean;
  conflicts: number;
  rejectedChunks: number;
  lastActivity: number;
  /** Source block size declared by repair packets (null until one arrives). */
  repairBlockSize: number | null;
  /** Buffered repair symbols per block (memory only: after a reload, new symbols are collected). */
  repair: Map<number, BlockRepair>;
  /** Timing: wall-clock first chunk / verification, accumulated active ms, start of the running segment. */
  firstChunkAt: number | null;
  verifiedAt: number | null;
  activeMs: number;
  clockMark: number | null;
}

interface SessionState {
  id: string;
  declaredFileCount: number | null;
  manifestPartCount: number | null;
  manifestPartsSeen: Set<number>;
  files: Map<number, FileState>;
  /** File ids the user deleted; their packets are ignored for this session. */
  dismissed: Set<number>;
  lastActivity: number;
}

/** Serializable engine state (spec §9.5). Typed arrays survive structured clone / IndexedDB. */
export interface PersistedFile {
  fileId: number;
  name: string | null;
  mimeType: string | null;
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  fileHash: Uint8Array;
  /** ChunkBitmap bytes. */
  bitmap: Uint8Array;
  fingerprints: Uint32Array;
  status: FileStatus;
  hasManifest: boolean;
  conflicts: number;
  rejectedChunks: number;
  lastActivity: number;
  /** Timing (absent in saves from before timing existed). */
  firstChunkAt?: number | null;
  verifiedAt?: number | null;
  activeMs?: number;
}

export interface PersistedSession {
  id: string;
  declaredFileCount: number | null;
  manifestPartCount: number | null;
  manifestPartsSeen: number[];
  dismissed: number[];
  lastActivity: number;
  files: PersistedFile[];
}

export interface RestoreReport {
  sessions: number;
  files: number;
  /** Chunks the saved state claimed but storage no longer has (evicted/cleared) — will be received again. */
  lostChunks: number;
  /** Chunks found in storage that the saved state had not recorded yet (crash before metadata save). */
  recoveredChunks: number;
  /** Saved records that failed validation and were discarded. */
  discarded: number;
}

export type ChangeListener = (sessionId: string) => void;

export interface ReceiverOptions {
  store: ChunkStore;
  limits?: Partial<ProtocolLimits>;
  now?: () => number;
}

export type ReceiverListener = (result: IngestResult) => void;

// ─────────────────────────── Engine ───────────────────────────

export class ReceiverEngine {
  readonly limits: ProtocolLimits;
  private readonly store: ChunkStore;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionState>();
  private readonly listeners = new Set<ReceiverListener>();
  private readonly changeListeners = new Set<ChangeListener>();
  /** Whether the receiver is actively scanning (drives per-file timing). */
  private receiving = true;
  private readonly _stats: ReceiverStats = {
    packetsSeen: 0, accepted: 0, duplicates: 0, manifests: 0, rejected: 0, conflicts: 0, storageFailures: 0, repairSymbols: 0, recoveredChunks: 0, rejectReasons: {},
  };
  private repairBytes = 0;

  constructor(opts: ReceiverOptions) {
    this.store = opts.store;
    this.limits = resolveLimits(opts.limits);
    this.now = opts.now ?? Date.now;
  }

  get stats(): Readonly<ReceiverStats> {
    return this._stats;
  }

  subscribe(listener: ReceiverListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Tell the engine whether the receiver is actively scanning. Per-file
   * transfer clocks only run while this is true, so pauses, leaving the
   * receive screen or a closed page do not count towards a file's time.
   * Defaults to true (an engine fed packets directly is receiving).
   */
  setReceiving(active: boolean): void {
    if (active === this.receiving) return;
    const now = this.now();
    this.receiving = active;
    for (const s of this.sessions.values()) {
      for (const f of s.files.values()) {
        if (f.firstChunkAt === null || f.verifiedAt !== null || f.status === 'hash-mismatch') continue;
        if (active) f.clockMark = now;
        else if (f.clockMark !== null) {
          f.activeMs += Math.max(0, now - f.clockMark);
          f.clockMark = null;
        }
      }
    }
  }

  get isReceiving(): boolean {
    return this.receiving;
  }

  /** Notified (with the session id) whenever persisted state changes. */
  onChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private changed(sessionId: string): void {
    for (const l of this.changeListeners) l(sessionId);
  }

  /** Process one packet. Never throws for bad input — returns a result instead. */
  async ingest(raw: Uint8Array): Promise<IngestResult> {
    this._stats.packetsSeen++;
    let result: IngestResult;
    try {
      const packet = decodePacket(raw, this.limits);
      result =
        packet.type === PacketType.Data ? await this.ingestData(packet)
        : packet.type === PacketType.Repair ? await this.ingestRepair(packet)
        : this.ingestManifest(packet);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      result = { status: 'rejected', reason: e.reason, detail: e.detail };
    }
    this.count(result);
    if (result.status === 'accepted' || result.status === 'manifest' || result.status === 'conflict' || (result.status === 'repair' && result.recovered > 0)) this.changed(result.sessionId);
    for (const l of this.listeners) l(result);
    return result;
  }

  // ── Data packets ──

  private async ingestData(p: DataPacket): Promise<IngestResult> {
    const sid = toHex(p.sessionId);
    const i = p.chunkIndex;
    const at = this.now();
    let session = this.sessions.get(sid);
    if (session?.dismissed.has(p.fileId)) return { status: 'duplicate', sessionId: sid, fileId: p.fileId, chunkIndex: i };
    let file = session?.files.get(p.fileId);

    if (file) {
      session!.lastActivity = at;
      file.lastActivity = at;
      const why = metadataMismatch(file, p);
      if (why) {
        file.conflicts++;
        return { status: 'conflict', sessionId: sid, fileId: p.fileId, chunkIndex: i, detail: why };
      }
      // Known duplicates are resolved without hashing (spec §16).
      if (file.status === 'verified' || file.pending.has(i)) return { status: 'duplicate', sessionId: sid, fileId: p.fileId, chunkIndex: i };
      if (file.bitmap.has(i)) {
        if (file.fingerprints[i] === fingerprint(p.chunkHash)) return { status: 'duplicate', sessionId: sid, fileId: p.fileId, chunkIndex: i };
        file.conflicts++;
        return { status: 'conflict', sessionId: sid, fileId: p.fileId, chunkIndex: i, detail: 'chunk hash differs from already-validated chunk; stored data kept' };
      }
    } else if (session && session.declaredFileCount !== null && p.fileId >= session.declaredFileCount) {
      return { status: 'conflict', sessionId: sid, fileId: p.fileId, detail: `file id ${p.fileId} not in manifest (${session.declaredFileCount} files)` };
    }

    // Verify before creating any state, so corrupt packets cannot consume session/file slots.
    if (!bytesEqual(sha256(p.payload), p.chunkHash)) {
      if (file) file.rejectedChunks++;
      throw new ProtocolError('chunk-hash-mismatch', `file ${p.fileId} chunk ${i}`);
    }

    if (!file) {
      const created = !session;
      session = this.sessionFor(sid);
      session.lastActivity = at;
      try {
        file = this.createFile(session, p.fileId, p, at);
      } catch (e) {
        if (created) this.sessions.delete(sid);
        throw e;
      }
    }

    file.pending.add(i);
    try {
      await this.store.put({ sessionId: sid, fileId: p.fileId, chunkIndex: i }, p.payload.slice());
    } catch (e) {
      file.pending.delete(i);
      return { status: 'storage-error', sessionId: sid, fileId: p.fileId, chunkIndex: i, detail: e instanceof Error ? e.message : String(e) };
    }
    file.pending.delete(i);
    // The file may have been reset/removed while the write was in flight.
    if (this.sessions.get(sid)?.files.get(p.fileId) !== file) return { status: 'duplicate', sessionId: sid, fileId: p.fileId, chunkIndex: i };

    if (file.bitmap.set(i)) {
      file.fingerprints[i] = fingerprint(p.chunkHash);
      file.storedBytes += p.payload.length;
      this.startClock(file, at);
    }
    // A new chunk may leave its block with enough repair symbols to rebuild the rest.
    if (file.repairBlockSize !== null) {
      const b = Math.floor(i / file.repairBlockSize);
      if (file.repair.has(b)) await this.trySolve(file, b);
    }
    if (file.bitmap.complete && file.status === 'receiving') await this.verify(file);
    return { status: 'accepted', sessionId: sid, fileId: p.fileId, chunkIndex: i, fileStatus: file.status };
  }

  private startClock(file: FileState, at: number): void {
    if (file.firstChunkAt !== null) return;
    // The file's clock starts at its first captured chunk.
    file.firstChunkAt = at;
    file.activeMs = 0;
    file.clockMark = this.receiving ? at : null;
  }

  // ── Repair packets (fountain code, PROTOCOL.md §5a) ──

  private async ingestRepair(p: RepairPacket): Promise<IngestResult> {
    const sid = toHex(p.sessionId);
    const at = this.now();
    let session = this.sessions.get(sid);
    const dup: IngestResult = { status: 'duplicate', sessionId: sid, fileId: p.fileId };
    if (session?.dismissed.has(p.fileId)) return dup;
    let file = session?.files.get(p.fileId);
    const { start, end } = blockRange(p.chunkCount, p.blockSize, p.blockIndex);

    if (file) {
      session!.lastActivity = at;
      file.lastActivity = at;
      const why = metadataMismatch(file, p) ?? (file.repairBlockSize !== null && file.repairBlockSize !== p.blockSize ? `repair block size ${p.blockSize} conflicts with ${file.repairBlockSize}` : null);
      if (why) {
        file.conflicts++;
        return { status: 'conflict', sessionId: sid, fileId: p.fileId, detail: why };
      }
      if (file.status !== 'receiving') return dup;
      // Nothing missing in this block, or this symbol is already held.
      let missing = 0;
      for (let i = start; i < end; i++) if (!file.bitmap.has(i)) missing++;
      if (missing === 0 || file.repair.get(p.blockIndex)?.symbols.has(p.symbolId)) return dup;
    } else if (session && session.declaredFileCount !== null && p.fileId >= session.declaredFileCount) {
      return { status: 'conflict', sessionId: sid, fileId: p.fileId, detail: `file id ${p.fileId} not in manifest (${session.declaredFileCount} files)` };
    }

    // Verify before keeping anything, so a damaged symbol can never poison a solve.
    if (!bytesEqual(sha256(p.payload), p.payloadHash)) {
      if (file) file.rejectedChunks++;
      throw new ProtocolError('repair-hash-mismatch', `file ${p.fileId} block ${p.blockIndex} symbol ${p.symbolId}`);
    }
    if (this.repairBytes + p.payload.length > MAX_REPAIR_BYTES) return dup;

    if (!file) {
      const created = !session;
      session = this.sessionFor(sid);
      session.lastActivity = at;
      try {
        file = this.createFile(session, p.fileId, p, at);
      } catch (e) {
        if (created) this.sessions.delete(sid);
        throw e;
      }
    }
    file.repairBlockSize = p.blockSize;
    let block = file.repair.get(p.blockIndex);
    if (!block) file.repair.set(p.blockIndex, (block = { symbols: new Map(), solving: false }));
    let missing = 0;
    for (let i = start; i < end; i++) if (!file.bitmap.has(i)) missing++;
    // Keep at most missing + slack symbols: drop the oldest (an unlucky set that left the block unsolved).
    while (block.symbols.size >= missing + REPAIR_SLACK) {
      const [oldId, old] = block.symbols.entries().next().value!;
      block.symbols.delete(oldId);
      this.repairBytes -= old.length;
    }
    block.symbols.set(p.symbolId, p.payload.slice());
    this.repairBytes += p.payload.length;
    const recovered = await this.trySolve(file, p.blockIndex);
    if (file.bitmap.complete && file.status === 'receiving') await this.verify(file);
    return { status: 'repair', sessionId: sid, fileId: p.fileId, blockIndex: p.blockIndex, recovered, fileStatus: file.status };
  }

  /**
   * Rebuild a block's missing chunks once its repair symbols determine them.
   * Returns how many chunks were recovered (0 if not solvable yet).
   */
  private async trySolve(file: FileState, blockIndex: number): Promise<number> {
    const block = file.repair.get(blockIndex);
    const bs = file.repairBlockSize;
    if (!block || bs === null || block.solving) return 0;
    const { start, end } = blockRange(file.chunkCount, bs, blockIndex);
    const unknown: number[] = [];
    for (let i = start; i < end; i++) if (!file.bitmap.has(i)) unknown.push(i - start);
    if (unknown.length === 0) {
      this.dropBlock(file, blockIndex);
      return 0;
    }
    if (block.symbols.size < unknown.length) return 0;
    block.solving = true;
    try {
      const n = end - start;
      const unknownSet = new Set(unknown);
      const known = new Map<number, Uint8Array>();
      for (let j = 0; j < n; j++) {
        if (unknownSet.has(j)) continue;
        const i = start + j;
        const data = await this.store.get({ sessionId: file.sessionId, fileId: file.fileId, chunkIndex: i });
        const len = chunkRange(file.fileSize, file.chunkSize, i).length;
        if (!data || data.length !== len) {
          // Evicted from storage: it is missing again, like at verification.
          if (file.bitmap.clear(i)) file.storedBytes -= len;
          return 0;
        }
        known.set(j, data);
      }
      const eqs = [...block.symbols].map(([id, payload]) => ({ coefs: coefficients(blockIndex, id, n), payload }));
      const solved = solveBlock(n, unknown, eqs, (j) => known.get(j)!);
      if (!solved) return 0;
      let recovered = 0;
      const at = this.now();
      for (const [j, padded] of solved) {
        const i = start + j;
        const len = chunkRange(file.fileSize, file.chunkSize, i).length;
        // Padding beyond a short last chunk must decode to zeros.
        if (padded.subarray(len).some((x) => x !== 0)) {
          file.conflicts++;
          this.dropBlock(file, blockIndex);
          return recovered;
        }
        if (file.bitmap.has(i)) continue; // arrived as a data packet meanwhile
        const data = padded.slice(0, len);
        await this.store.put({ sessionId: file.sessionId, fileId: file.fileId, chunkIndex: i }, data);
        if (this.sessions.get(file.sessionId)?.files.get(file.fileId) !== file) return recovered;
        if (file.bitmap.set(i)) {
          file.fingerprints[i] = fingerprint(sha256(data));
          file.storedBytes += len;
          this.startClock(file, at);
          recovered++;
        }
      }
      this._stats.recoveredChunks += recovered;
      this.dropBlock(file, blockIndex);
      return recovered;
    } catch {
      // A failed write leaves the chunk missing; symbols are kept for the next attempt.
      return 0;
    } finally {
      block.solving = false;
    }
  }

  private releaseRepair(file: FileState): void {
    for (const b of [...file.repair.keys()]) this.dropBlock(file, b);
  }

  private dropBlock(file: FileState, blockIndex: number): void {
    const block = file.repair.get(blockIndex);
    if (!block) return;
    for (const v of block.symbols.values()) this.repairBytes -= v.length;
    file.repair.delete(blockIndex);
  }

  // ── Manifest packets ──

  private ingestManifest(m: ManifestPacket): IngestResult {
    const sid = toHex(m.sessionId);
    const session = this.sessionFor(sid);
    session.lastActivity = this.now();

    if (session.declaredFileCount !== null && session.declaredFileCount !== m.fileCount) {
      return { status: 'conflict', sessionId: sid, detail: `manifest declares ${m.fileCount} files, previously ${session.declaredFileCount}` };
    }
    if (session.manifestPartCount !== null && session.manifestPartCount !== m.partCount) {
      return { status: 'conflict', sessionId: sid, detail: `manifest declares ${m.partCount} parts, previously ${session.manifestPartCount}` };
    }
    for (const [id] of session.files) {
      if (id >= m.fileCount) return { status: 'conflict', sessionId: sid, fileId: id, detail: `known file id ${id} outside manifest file count ${m.fileCount}` };
    }
    // Validate every entry before applying any (atomic).
    for (const e of m.entries) {
      const f = session.files.get(e.fileId);
      const why = f ? metadataMismatch(f, e) : null;
      if (why) {
        f!.conflicts++;
        return { status: 'conflict', sessionId: sid, fileId: e.fileId, detail: why };
      }
      if (f && f.hasManifest && (f.name !== e.name || (f.mimeType ?? '') !== e.mimeType)) {
        f.conflicts++;
        return { status: 'conflict', sessionId: sid, fileId: e.fileId, detail: 'manifest name/type differs from earlier manifest' };
      }
    }
    const newCount = m.entries.filter((e) => !session.files.has(e.fileId) && !session.dismissed.has(e.fileId)).length;
    try {
      this.checkCapacity(session, newCount);
    } catch (e) {
      if (session.files.size === 0 && session.manifestPartsSeen.size === 0) this.sessions.delete(sid);
      throw e;
    }

    const alreadySeen = session.manifestPartsSeen.has(m.partIndex);
    session.declaredFileCount = m.fileCount;
    session.manifestPartCount = m.partCount;
    session.manifestPartsSeen.add(m.partIndex);
    let newFiles = 0;
    for (const e of m.entries) {
      if (session.dismissed.has(e.fileId)) continue;
      let f = session.files.get(e.fileId);
      if (!f) {
        f = this.createFile(session, e.fileId, e, session.lastActivity);
        newFiles++;
      }
      f.name = e.name;
      f.mimeType = e.mimeType === '' ? null : e.mimeType;
      f.hasManifest = true;
    }
    if (alreadySeen && newFiles === 0) return { status: 'duplicate', sessionId: sid };
    return { status: 'manifest', sessionId: sid, part: m.partIndex, newFiles };
  }

  // ── Verification & reconstruction ──

  private async verify(file: FileState): Promise<void> {
    file.status = 'verifying';
    const h = new Sha256();
    for (let i = 0; i < file.chunkCount; i++) {
      const data = await this.store.get({ sessionId: file.sessionId, fileId: file.fileId, chunkIndex: i });
      const expectedLen = chunkRange(file.fileSize, file.chunkSize, i).length;
      if (!data || data.length !== expectedLen) {
        // Evicted or damaged in storage: make it eligible for retransmission again.
        if (file.bitmap.clear(i)) file.storedBytes -= expectedLen;
        file.status = 'receiving';
        return;
      }
      h.update(data);
    }
    file.status = bytesEqual(h.digest(), file.fileHash) ? 'verified' : 'hash-mismatch';
    // Stop the file's clock: verified (final speed) or failed (no speed).
    const now = this.now();
    if (file.clockMark !== null) {
      file.activeMs += Math.max(0, now - file.clockMark);
      file.clockMark = null;
    }
    if (file.status === 'verified') {
      file.verifiedAt = now;
      this.releaseRepair(file);
    }
  }

  /**
   * Stream the reconstructed bytes of a verified file, in order. Each chunk is
   * re-checked against its fingerprint so storage corruption after
   * verification cannot reach the user silently.
   */
  async *readFile(sessionId: string, fileId: number): AsyncGenerator<Uint8Array> {
    const file = this.sessions.get(sessionId)?.files.get(fileId);
    if (!file) throw new Error('unknown file');
    if (file.status !== 'verified') throw new Error(`file is not verified (status: ${file.status})`);
    for (let i = 0; i < file.chunkCount; i++) {
      const data = await this.store.get({ sessionId, fileId, chunkIndex: i });
      if (!data || fingerprint(sha256(data)) !== file.fingerprints[i]) {
        file.status = 'receiving';
        if (file.bitmap.clear(i)) file.storedBytes -= chunkRange(file.fileSize, file.chunkSize, i).length;
        this.changed(sessionId);
        throw new Error(`chunk ${i} missing or damaged in storage; the file must be received again`);
      }
      yield data;
    }
  }

  // ── Management ──

  /** Discard a file's chunks so it can be received again (e.g. after a hash mismatch). */
  async resetFile(sessionId: string, fileId: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    const f = session?.files.get(fileId);
    if (!session || !f) return;
    this.releaseRepair(f);
    await this.store.deleteFile(sessionId, fileId);
    const fresh = this.newFileState(sessionId, fileId, f, this.now());
    fresh.name = f.name;
    fresh.mimeType = f.mimeType;
    fresh.hasManifest = f.hasManifest;
    session.files.set(fileId, fresh);
    this.changed(sessionId);
  }

  /**
   * Delete one file (spec §11.2). Its chunks are removed and further packets
   * for it in this session are ignored, so a sender that is still looping
   * does not bring it back.
   */
  async removeFile(sessionId: string, fileId: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.files.has(fileId)) return;
    this.releaseRepair(session.files.get(fileId)!);
    session.files.delete(fileId);
    session.dismissed.add(fileId);
    await this.store.deleteFile(sessionId, fileId);
    this.changed(sessionId);
  }

  async removeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const f of s.files.values()) this.releaseRepair(f);
    this.sessions.delete(sessionId);
    await this.store.deleteSession(sessionId);
    this.changed(sessionId);
  }

  /** All session ids currently held (including ones whose files were all deleted). */
  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  // ── Persistence ──

  exportSession(sessionId: string): PersistedSession | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return {
      id: s.id,
      declaredFileCount: s.declaredFileCount,
      manifestPartCount: s.manifestPartCount,
      manifestPartsSeen: [...s.manifestPartsSeen],
      dismissed: [...s.dismissed],
      lastActivity: s.lastActivity,
      files: [...s.files.values()].map((f) => ({
        fileId: f.fileId,
        name: f.name,
        mimeType: f.mimeType,
        fileSize: f.fileSize,
        chunkSize: f.chunkSize,
        chunkCount: f.chunkCount,
        fileHash: f.fileHash.slice(),
        bitmap: f.bitmap.toBytes(),
        fingerprints: f.fingerprints.slice(),
        // A file mid-verification is saved as receiving; it re-verifies on restore.
        status: f.status === 'verifying' ? 'receiving' : f.status,
        hasManifest: f.hasManifest,
        conflicts: f.conflicts,
        rejectedChunks: f.rejectedChunks,
        lastActivity: f.lastActivity,
        firstChunkAt: f.firstChunkAt,
        verifiedAt: f.verifiedAt,
        activeMs: elapsed(f, this.now()),
      })),
    };
  }

  /**
   * Restore saved sessions, reconciling them with what the chunk store
   * actually holds (stored chunks are the source of truth). Call before
   * ingesting any packets.
   */
  async restore(saved: readonly PersistedSession[]): Promise<RestoreReport> {
    const report: RestoreReport = { sessions: 0, files: 0, lostChunks: 0, recoveredChunks: 0, discarded: 0 };
    for (const ps of saved) {
      if (!validSession(ps)) { report.discarded++; continue; }
      const s: SessionState = {
        id: ps.id,
        declaredFileCount: ps.declaredFileCount,
        manifestPartCount: ps.manifestPartCount,
        manifestPartsSeen: new Set(ps.manifestPartsSeen),
        files: new Map(),
        dismissed: new Set(ps.dismissed),
        lastActivity: ps.lastActivity,
      };
      for (const pf of ps.files) {
        if (!validFile(pf, this.limits)) { report.discarded++; continue; }
        const f = this.newFileState(ps.id, pf.fileId, pf, pf.lastActivity);
        f.name = pf.name;
        f.mimeType = pf.mimeType;
        f.hasManifest = pf.hasManifest;
        f.conflicts = pf.conflicts;
        f.rejectedChunks = pf.rejectedChunks;
        f.firstChunkAt = typeof pf.firstChunkAt === 'number' ? pf.firstChunkAt : null;
        f.verifiedAt = typeof pf.verifiedAt === 'number' ? pf.verifiedAt : null;
        f.activeMs = typeof pf.activeMs === 'number' && pf.activeMs >= 0 ? pf.activeMs : 0;
        f.clockMark = null; // the clock resumes when scanning does
        const savedBits = new ChunkBitmap(pf.chunkCount, pf.bitmap);
        const present = await this.store.listChunks(ps.id, pf.fileId);
        for (let i = 0; i < pf.chunkCount; i++) {
          const expected = chunkRange(pf.fileSize, pf.chunkSize, i).length;
          const have = present.get(i) === expected;
          if (savedBits.has(i) && have) {
            f.bitmap.set(i);
            f.fingerprints[i] = pf.fingerprints[i]!;
            f.storedBytes += expected;
          } else if (savedBits.has(i)) {
            report.lostChunks++;
          } else if (have) {
            // Written to storage but not yet recorded in the saved state: recover it.
            const data = await this.store.get({ sessionId: ps.id, fileId: pf.fileId, chunkIndex: i });
            if (data && data.length === expected) {
              f.bitmap.set(i);
              f.fingerprints[i] = fingerprint(sha256(data));
              f.storedBytes += expected;
              report.recoveredChunks++;
            }
          }
        }
        if (pf.status === 'hash-mismatch' && f.bitmap.complete) f.status = 'hash-mismatch';
        else if (pf.status === 'verified' && f.bitmap.complete) f.status = 'verified';
        else f.status = 'receiving';
        if (f.status !== 'verified') f.verifiedAt = null;
        if (f.firstChunkAt !== null && f.bitmap.count === 0) { f.firstChunkAt = null; f.activeMs = 0; }
        if (f.status === 'receiving' && f.firstChunkAt !== null && this.receiving) f.clockMark = this.now();
        s.files.set(pf.fileId, f);
        report.files++;
      }
      this.sessions.set(s.id, s);
      report.sessions++;
      // A file that became complete through recovery still needs its full-file check.
      for (const f of s.files.values()) if (f.status === 'receiving' && f.bitmap.complete) await this.verify(f);
    }
    return report;
  }

  bitmap(sessionId: string, fileId: number): ChunkBitmap | undefined {
    return this.sessions.get(sessionId)?.files.get(fileId)?.bitmap;
  }

  snapshot(): SessionSnapshot[] {
    return [...this.sessions.values()].filter((s) => s.files.size > 0).map((s) => {
      const now = this.now();
      const files = [...s.files.values()].sort((a, b) => a.fileId - b.fileId).map((f) => fileSnapshot(f, now));
      const totalBytes = files.reduce((n, f) => n + f.fileSize, 0);
      const storedBytes = files.reduce((n, f) => n + f.storedBytes, 0);
      const allFilesKnown = s.declaredFileCount !== null && s.files.size + s.dismissed.size === s.declaredFileCount;
      let progress: number;
      if (totalBytes > 0) progress = storedBytes / totalBytes;
      else {
        const chunks = files.reduce((n, f) => n + f.chunkCount, 0);
        progress = chunks === 0 ? 0 : files.reduce((n, f) => n + f.receivedChunks, 0) / chunks;
      }
      return {
        sessionId: s.id,
        declaredFileCount: s.declaredFileCount,
        manifestPartsSeen: s.manifestPartsSeen.size,
        manifestPartCount: s.manifestPartCount,
        allFilesKnown,
        files,
        totalBytes,
        storedBytes,
        progress,
        complete: allFilesKnown && files.every((f) => f.status === 'verified'),
        lastActivity: s.lastActivity,
      };
    });
  }

  // ── Internals ──

  private sessionFor(sid: string): SessionState {
    let s = this.sessions.get(sid);
    if (s) return s;
    // Only transfers still in progress count towards the limit; finished ones stay
    // listed (and persisted) until the user deletes them.
    const active = [...this.sessions.values()].filter((x) => x.files.size === 0 ? x.dismissed.size === 0 : [...x.files.values()].some((f) => f.status !== 'verified')).length;
    if (active >= this.limits.maxActiveSessions) {
      throw new ProtocolError('limit-exceeded', `too many transfers in progress (max ${this.limits.maxActiveSessions}); finish or delete one`);
    }
    s = { id: sid, declaredFileCount: null, manifestPartCount: null, manifestPartsSeen: new Set(), files: new Map(), dismissed: new Set(), lastActivity: this.now() };
    this.sessions.set(sid, s);
    return s;
  }

  private checkCapacity(session: SessionState, adding: number): void {
    if (adding === 0) return;
    if (session.files.size + adding > this.limits.maxFilesPerSession) {
      throw new ProtocolError('limit-exceeded', `too many files in session (max ${this.limits.maxFilesPerSession})`);
    }
    let incomplete = 0;
    for (const s of this.sessions.values()) for (const f of s.files.values()) if (f.status !== 'verified') incomplete++;
    if (incomplete + adding > this.limits.maxIncompleteFiles) {
      throw new ProtocolError('limit-exceeded', `too many incomplete files (max ${this.limits.maxIncompleteFiles})`);
    }
  }

  private createFile(session: SessionState, fileId: number, meta: FileMeta, at: number): FileState {
    this.checkCapacity(session, 1);
    const f = this.newFileState(session.id, fileId, meta, at);
    session.files.set(fileId, f);
    return f;
  }

  private newFileState(sessionId: string, fileId: number, meta: FileMeta, at: number): FileState {
    return {
      sessionId,
      fileId,
      name: null,
      mimeType: null,
      fileSize: meta.fileSize,
      chunkSize: meta.chunkSize,
      chunkCount: meta.chunkCount,
      fileHash: meta.fileHash.slice(),
      bitmap: new ChunkBitmap(meta.chunkCount),
      fingerprints: new Uint32Array(meta.chunkCount),
      pending: new Set(),
      repairBlockSize: null,
      repair: new Map(),
      storedBytes: 0,
      status: 'receiving',
      hasManifest: false,
      conflicts: 0,
      rejectedChunks: 0,
      lastActivity: at,
      firstChunkAt: null,
      verifiedAt: null,
      activeMs: 0,
      clockMark: null,
    };
  }

  private count(r: IngestResult): void {
    const s = this._stats;
    switch (r.status) {
      case 'accepted': s.accepted++; break;
      case 'duplicate': s.duplicates++; break;
      case 'manifest': s.manifests++; break;
      case 'conflict': s.conflicts++; break;
      case 'storage-error': s.storageFailures++; break;
      case 'repair': s.repairSymbols++; break;
      case 'rejected':
        s.rejected++;
        s.rejectReasons[r.reason] = (s.rejectReasons[r.reason] ?? 0) + 1;
        break;
    }
  }
}

// ─────────────────────────── Helpers ───────────────────────────

interface FileMeta {
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  fileHash: Uint8Array;
}

function metadataMismatch(f: FileMeta, m: FileMeta): string | null {
  if (f.fileSize !== m.fileSize) return `file size ${m.fileSize} conflicts with ${f.fileSize}`;
  if (f.chunkSize !== m.chunkSize) return `chunk size ${m.chunkSize} conflicts with ${f.chunkSize}`;
  if (f.chunkCount !== m.chunkCount) return `chunk count ${m.chunkCount} conflicts with ${f.chunkCount}`;
  if (!bytesEqual(f.fileHash, m.fileHash)) return 'file hash conflicts with earlier packets';
  return null;
}

function isInt(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function validSession(ps: PersistedSession): boolean {
  return !!ps && typeof ps.id === 'string' && /^[0-9a-f]{16}$/.test(ps.id) && Array.isArray(ps.files) &&
    (ps.declaredFileCount === null || isInt(ps.declaredFileCount, 1, 0xffff)) &&
    (ps.manifestPartCount === null || isInt(ps.manifestPartCount, 1, 0xffff)) &&
    Array.isArray(ps.manifestPartsSeen) && ps.manifestPartsSeen.every((n) => isInt(n, 0, 0xffff)) &&
    Array.isArray(ps.dismissed ?? []) && (ps.dismissed ?? []).every((n) => isInt(n, 0, 0xffff)) &&
    typeof ps.lastActivity === 'number';
}

function validFile(pf: PersistedFile, limits: ProtocolLimits): boolean {
  if (!pf || !isInt(pf.fileId, 0, 0xffff) || !isInt(pf.fileSize, 0, limits.maxFileSize) || !isInt(pf.chunkSize, 1, limits.maxPayloadLength)) return false;
  if (!isInt(pf.chunkCount, 1, limits.maxChunkCount) || pf.chunkCount !== (pf.fileSize === 0 ? 1 : Math.ceil(pf.fileSize / pf.chunkSize))) return false;
  if (!(pf.fileHash instanceof Uint8Array) || pf.fileHash.length !== 32) return false;
  if (!(pf.bitmap instanceof Uint8Array) || pf.bitmap.length !== Math.ceil(pf.chunkCount / 8)) return false;
  if (!(pf.fingerprints instanceof Uint32Array) || pf.fingerprints.length !== pf.chunkCount) return false;
  if (!['receiving', 'verifying', 'verified', 'hash-mismatch'].includes(pf.status)) return false;
  if (pf.name !== null && typeof pf.name !== 'string') return false;
  if (pf.mimeType !== null && typeof pf.mimeType !== 'string') return false;
  return true;
}

function fingerprint(hash: Uint8Array): number {
  return ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0;
}

function elapsed(f: FileState, now: number): number {
  return f.activeMs + (f.clockMark !== null ? Math.max(0, now - f.clockMark) : 0);
}

/** Below this much measured time a rate is noise (e.g. a file that fit in one capture). */
export const MIN_TIMED_MS = 1000;

export function fileTiming(f: Pick<FileState, 'firstChunkAt' | 'verifiedAt' | 'activeMs' | 'clockMark' | 'status' | 'fileSize' | 'storedBytes'>, now: number): FileTiming {
  const ms = f.firstChunkAt === null ? 0 : elapsed(f as FileState, now);
  let rate: number | null = null;
  if (f.firstChunkAt !== null && ms >= MIN_TIMED_MS) {
    if (f.status === 'verified') rate = f.fileSize > 0 ? (f.fileSize * 1000) / ms : null;
    else if (f.status === 'receiving' || f.status === 'verifying') rate = (f.storedBytes * 1000) / ms;
  }
  return { startedAt: f.firstChunkAt, verifiedAt: f.verifiedAt, elapsedMs: ms, bytesPerSecond: rate };
}

function fileSnapshot(f: FileState, now: number): FileSnapshot {
  const received = f.bitmap.count;
  return {
    sessionId: f.sessionId,
    fileId: f.fileId,
    name: f.name,
    displayName: sanitizeFileName(f.name ?? '', `file-${f.fileId + 1}`),
    mimeType: f.mimeType,
    fileSize: f.fileSize,
    chunkSize: f.chunkSize,
    chunkCount: f.chunkCount,
    receivedChunks: received,
    missingChunks: f.chunkCount - received,
    storedBytes: f.storedBytes,
    progress: f.fileSize > 0 ? f.storedBytes / f.fileSize : received / f.chunkCount,
    status: f.status,
    hasManifest: f.hasManifest,
    conflicts: f.conflicts,
    rejectedChunks: f.rejectedChunks,
    lastActivity: f.lastActivity,
    timing: fileTiming(f, now),
  };
}
