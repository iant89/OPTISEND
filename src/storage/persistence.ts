/**
 * Wires a ReceiverEngine to durable storage: restores saved transfers at
 * start-up, saves metadata shortly after every change (and immediately when
 * the page is hidden or closed), and exposes storage management (§11.2).
 *
 * Falls back to in-memory storage when IndexedDB is unavailable (e.g. some
 * private-browsing modes) — the UI then warns that nothing survives a reload.
 */
import { MemoryChunkStore, type ChunkStore } from '../protocol/chunk-store.ts';
import { ReceiverEngine, type RestoreReport } from '../protocol/receiver.ts';
import type { ProtocolLimits } from '../protocol/limits.ts';
import { IdbChunkStore, IdbSessionStore, openDatabase } from './idb.ts';

export interface StorageEstimateInfo {
  usage: number | null;
  quota: number | null;
  /** True if the browser granted persistent storage (exempt from automatic eviction). */
  persisted: boolean | null;
}

export interface StorageStatus {
  durable: boolean;
  /** Why storage is not durable (only when durable === false). */
  reason: string | null;
  /** Last failed metadata save, if any (spec §11.2 "failed storage operations"). */
  lastSaveError: string | null;
  saveFailures: number;
}

export class ReceiverStorage {
  private dirty = new Set<string>();
  /** Session ids known to have a saved record. */
  private readonly saved = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private readonly status: StorageStatus;
  private readonly offChange: () => void;
  private readonly onHide = () => { if (document.visibilityState === 'hidden') void this.flush(); };
  private readonly onPageHide = () => void this.flush();

  private constructor(
    readonly engine: ReceiverEngine,
    private readonly sessions: IdbSessionStore | null,
    readonly restoreReport: (RestoreReport & { orphanBytesReclaimed?: number }) | null,
    reason: string | null,
    private readonly debounceMs: number,
  ) {
    this.status = { durable: sessions !== null, reason, lastSaveError: null, saveFailures: 0 };
    this.offChange = engine.onChange((sid) => this.markDirty(sid));
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onHide);
      window.addEventListener('pagehide', this.onPageHide);
    }
  }

  /** Open storage, restore saved transfers, and return a ready engine. */
  static async open(opts: { limits?: Partial<ProtocolLimits>; dbName?: string; debounceMs?: number } = {}): Promise<ReceiverStorage> {
    const debounceMs = opts.debounceMs ?? 400;
    try {
      const db = await openDatabase(opts.dbName);
      const chunks = new IdbChunkStore(db);
      const sessions = new IdbSessionStore(db);
      const engine = new ReceiverEngine({ store: chunks, ...(opts.limits ? { limits: opts.limits } : {}) });
      engine.setReceiving(false); // file clocks run only while the receive screen is scanning
      const saved = await sessions.loadAll();
      // Chunks with no saved transfer record (page closed before the first save) can't be
      // reattached — reclaim their space.
      const orphanBytes = await sessions.deleteOrphanChunks(new Set(saved.map((x) => x.id))).catch(() => 0);
      const report = await engine.restore(saved);
      const st = new ReceiverStorage(engine, sessions, { ...report, orphanBytesReclaimed: orphanBytes }, null, debounceMs);
      for (const x of saved) st.saved.add(x.id);
      return st;
    } catch (e) {
      const store: ChunkStore = new MemoryChunkStore();
      const engine = new ReceiverEngine({ store, ...(opts.limits ? { limits: opts.limits } : {}) });
      engine.setReceiving(false);
      const reason = e instanceof Error ? e.message : String(e);
      return new ReceiverStorage(engine, null, null, reason, debounceMs);
    }
  }

  get state(): Readonly<StorageStatus> {
    return this.status;
  }

  private markDirty(sessionId: string): void {
    if (!this.sessions) return;
    this.dirty.add(sessionId);
    // A transfer that has never been saved is saved immediately: until its record exists,
    // its stored chunks could not be reattached after a reload.
    if (!this.saved.has(sessionId)) {
      void this.flush();
      return;
    }
    if (this.timer === null) this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Write all pending metadata now. Safe to call repeatedly. */
  flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (!this.sessions || this.dirty.size === 0) return this.saving;
    const ids = [...this.dirty];
    this.dirty.clear();
    const store = this.sessions;
    this.saving = this.saving.then(async () => {
      const save = [];
      const del = [];
      for (const id of ids) {
        const s = this.engine.exportSession(id);
        if (s) save.push(s);
        else del.push(id);
      }
      try {
        await store.save(save, del);
        for (const x of save) this.saved.add(x.id);
        for (const id of del) this.saved.delete(id);
        this.status.lastSaveError = null;
      } catch (e) {
        this.status.saveFailures++;
        this.status.lastSaveError = e instanceof Error ? e.message : String(e);
        for (const id of ids) this.dirty.add(id); // retry with the next change / flush
      }
    });
    return this.saving;
  }

  /** Bytes OptiSend has stored, per session id. */
  async usageBySession(): Promise<Map<string, number>> {
    if (!this.sessions) return new Map();
    try {
      return await this.sessions.usageBySession();
    } catch {
      return new Map();
    }
  }

  /** Delete every transfer and all stored data (after user confirmation). */
  async clearAll(): Promise<void> {
    for (const id of this.engine.sessionIds()) await this.engine.removeSession(id);
    this.dirty.clear();
    await this.sessions?.clearAll();
  }

  static async estimate(): Promise<StorageEstimateInfo> {
    const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    let usage: number | null = null;
    let quota: number | null = null;
    let persisted: boolean | null = null;
    try {
      const e = await s?.estimate?.();
      usage = e?.usage ?? null;
      quota = e?.quota ?? null;
    } catch { /* unsupported */ }
    try {
      persisted = (await s?.persisted?.()) ?? null;
    } catch { /* unsupported */ }
    return { usage, quota, persisted };
  }

  /** Ask the browser to exempt OptiSend's storage from automatic eviction. */
  static async requestPersistence(): Promise<boolean> {
    try {
      return (await navigator.storage?.persist?.()) ?? false;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.offChange();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onHide);
      window.removeEventListener('pagehide', this.onPageHide);
    }
  }
}
