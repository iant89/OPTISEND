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
import { decodePacket, type DataPacket, type ManifestPacket } from './packet.ts';

// ───────────────────────────── Types ─────────────────────────────

export type FileStatus = 'receiving' | 'verifying' | 'verified' | 'hash-mismatch';

export type IngestResult =
  | { status: 'accepted'; sessionId: string; fileId: number; chunkIndex: number; fileStatus: FileStatus }
  | { status: 'duplicate'; sessionId: string; fileId?: number; chunkIndex?: number }
  | { status: 'manifest'; sessionId: string; part: number; newFiles: number }
  | { status: 'conflict'; sessionId: string; fileId?: number; chunkIndex?: number; detail: string }
  | { status: 'rejected'; reason: RejectReason; detail: string }
  | { status: 'storage-error'; sessionId: string; fileId: number; chunkIndex: number; detail: string };

export interface ReceiverStats {
  packetsSeen: number;
  accepted: number;
  duplicates: number;
  manifests: number;
  rejected: number;
  conflicts: number;
  storageFailures: number;
  rejectReasons: Partial<Record<RejectReason, number>>;
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
  private readonly _stats: ReceiverStats = {
    packetsSeen: 0, accepted: 0, duplicates: 0, manifests: 0, rejected: 0, conflicts: 0, storageFailures: 0, rejectReasons: {},
  };

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
      result = packet.type === PacketType.Data ? await this.ingestData(packet) : this.ingestManifest(packet);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      result = { status: 'rejected', reason: e.reason, detail: e.detail };
    }
    this.count(result);
    if ((result.status === 'accepted' || result.status === 'manifest' || result.status === 'conflict')) this.changed(result.sessionId);
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
    }
    if (file.bitmap.complete && file.status === 'receiving') await this.verify(file);
    return { status: 'accepted', sessionId: sid, fileId: p.fileId, chunkIndex: i, fileStatus: file.status };
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
    session.files.delete(fileId);
    session.dismissed.add(fileId);
    await this.store.deleteFile(sessionId, fileId);
    this.changed(sessionId);
  }

  async removeSession(sessionId: string): Promise<void> {
    if (!this.sessions.delete(sessionId)) return;
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
      const files = [...s.files.values()].sort((a, b) => a.fileId - b.fileId).map(fileSnapshot);
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
      storedBytes: 0,
      status: 'receiving',
      hasManifest: false,
      conflicts: 0,
      rejectedChunks: 0,
      lastActivity: at,
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

function fileSnapshot(f: FileState): FileSnapshot {
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
  };
}
