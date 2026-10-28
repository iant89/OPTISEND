/**
 * IndexedDB persistence (spec §4.2 "Browser Storage", §9.4–9.5, §11.2).
 *
 * Object stores (database "optisend", version 1):
 *   chunks     key [sessionId, fileId, chunkIndex] → Uint8Array payload
 *   chunkMeta  same key → byte length (lets restore list chunks without loading data)
 *   sessions   key sessionId → PersistedSession (engine metadata, bitmaps, fingerprints)
 *
 * A chunk write resolves only when its transaction COMMITS, so the engine
 * never counts a chunk that is not durably stored (acceptance criterion 8).
 */
import type { ChunkKey, ChunkStore } from '../protocol/chunk-store.ts';
import { StorageQuotaError } from '../protocol/chunk-store.ts';
import type { PersistedSession } from '../protocol/receiver.ts';

export const DB_NAME = 'optisend';
export const DB_VERSION = 1;
const CHUNKS = 'chunks';
const CHUNK_META = 'chunkMeta';
const SESSIONS = 'sessions';

export class StorageUnavailableError extends Error {
  override name = 'StorageUnavailableError';
}

export function openDatabase(name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
      req = indexedDB.open(name, DB_VERSION);
    } catch (e) {
      reject(new StorageUnavailableError(e instanceof Error ? e.message : String(e)));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS);
      if (!db.objectStoreNames.contains(CHUNK_META)) db.createObjectStore(CHUNK_META);
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema: close so it can proceed.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(new StorageUnavailableError(req.error?.message ?? 'could not open IndexedDB'));
    req.onblocked = () => reject(new StorageUnavailableError('IndexedDB open blocked by another tab'));
  });
}

/** Map IndexedDB failures to the errors the app understands. */
export function classifyStorageError(e: unknown): Error {
  const name = (e as { name?: string } | null)?.name ?? '';
  const msg = (e as { message?: string } | null)?.message ?? String(e);
  if (name === 'QuotaExceededError' || /quota/i.test(msg)) return new StorageQuotaError('Browser storage is full');
  return e instanceof Error ? e : new Error(msg);
}

/** Run a transaction and resolve with `result()` only after it commits. */
function run<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => void, result: () => T, durability: 'strict' | 'default' = 'default'): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = mode === 'readwrite' ? db.transaction(stores, mode, { durability }) : db.transaction(stores, mode);
    } catch (e) {
      reject(classifyStorageError(e));
      return;
    }
    tx.oncomplete = () => resolve(result());
    // A failed request aborts the transaction (we never preventDefault), so a write
    // that did not land can never be reported as committed.
    tx.onabort = () => reject(classifyStorageError(tx.error ?? new Error('transaction aborted')));
    try {
      body(tx);
    } catch (e) {
      try { tx.abort(); } catch { /* already finished */ }
      reject(classifyStorageError(e));
    }
  });
}

const fileRange = (sessionId: string, fileId: number) => IDBKeyRange.bound([sessionId, fileId, 0], [sessionId, fileId, Infinity]);
const sessionRange = (sessionId: string) => IDBKeyRange.bound([sessionId, -Infinity, -Infinity], [sessionId, Infinity, Infinity]);

export class IdbChunkStore implements ChunkStore {
  constructor(private readonly db: IDBDatabase) {}

  put(key: ChunkKey, data: Uint8Array): Promise<void> {
    const k = [key.sessionId, key.fileId, key.chunkIndex];
    return run(this.db, [CHUNKS, CHUNK_META], 'readwrite', (tx) => {
      tx.objectStore(CHUNKS).put(data, k);
      tx.objectStore(CHUNK_META).put(data.length, k);
    }, () => undefined, 'strict');
  }

  get(key: ChunkKey): Promise<Uint8Array | undefined> {
    let out: Uint8Array | undefined;
    return run(this.db, [CHUNKS], 'readonly', (tx) => {
      const r = tx.objectStore(CHUNKS).get([key.sessionId, key.fileId, key.chunkIndex]);
      r.onsuccess = () => { out = r.result instanceof Uint8Array ? r.result : undefined; };
    }, () => out);
  }

  listChunks(sessionId: string, fileId: number): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    return run(this.db, [CHUNK_META], 'readonly', (tx) => {
      const req = tx.objectStore(CHUNK_META).openCursor(fileRange(sessionId, fileId));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        const k = c.key as [string, number, number];
        if (typeof c.value === 'number') out.set(k[2], c.value);
        c.continue();
      };
    }, () => out);
  }

  deleteFile(sessionId: string, fileId: number): Promise<void> {
    return run(this.db, [CHUNKS, CHUNK_META], 'readwrite', (tx) => {
      tx.objectStore(CHUNKS).delete(fileRange(sessionId, fileId));
      tx.objectStore(CHUNK_META).delete(fileRange(sessionId, fileId));
    }, () => undefined);
  }

  deleteSession(sessionId: string): Promise<void> {
    return run(this.db, [CHUNKS, CHUNK_META, SESSIONS], 'readwrite', (tx) => {
      tx.objectStore(CHUNKS).delete(sessionRange(sessionId));
      tx.objectStore(CHUNK_META).delete(sessionRange(sessionId));
      tx.objectStore(SESSIONS).delete(sessionId);
    }, () => undefined);
  }
}

export class IdbSessionStore {
  constructor(private readonly db: IDBDatabase) {}

  save(sessions: PersistedSession[], deleted: string[]): Promise<void> {
    return run(this.db, [SESSIONS], 'readwrite', (tx) => {
      const st = tx.objectStore(SESSIONS);
      for (const s of sessions) st.put(s, s.id);
      for (const id of deleted) st.delete(id);
    }, () => undefined);
  }

  loadAll(): Promise<PersistedSession[]> {
    let out: PersistedSession[] = [];
    return run(this.db, [SESSIONS], 'readonly', (tx) => {
      const r = tx.objectStore(SESSIONS).getAll();
      r.onsuccess = () => { out = Array.isArray(r.result) ? (r.result as PersistedSession[]) : []; };
    }, () => out);
  }

  /** Total payload bytes stored per session (from chunkMeta, without loading chunk data). */
  usageBySession(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    return run(this.db, [CHUNK_META], 'readonly', (tx) => {
      const req = tx.objectStore(CHUNK_META).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        const sid = (c.key as [string, number, number])[0];
        if (typeof c.value === 'number') out.set(sid, (out.get(sid) ?? 0) + c.value);
        c.continue();
      };
    }, () => out);
  }

  clearAll(): Promise<void> {
    return run(this.db, [CHUNKS, CHUNK_META, SESSIONS], 'readwrite', (tx) => {
      tx.objectStore(CHUNKS).clear();
      tx.objectStore(CHUNK_META).clear();
      tx.objectStore(SESSIONS).clear();
    }, () => undefined);
  }
}
