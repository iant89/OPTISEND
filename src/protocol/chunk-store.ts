/**
 * Chunk persistence boundary. Phase 4 supplies an IndexedDB implementation;
 * the receiver engine only ever marks a chunk received after `put` resolves
 * (spec §9.4, acceptance criterion 8).
 *
 * Keys isolate data by session + file + chunk index (spec §7.2).
 */

export interface ChunkKey {
  /** Hex session id. */
  sessionId: string;
  fileId: number;
  chunkIndex: number;
}

export interface ChunkStore {
  put(key: ChunkKey, data: Uint8Array): Promise<void>;
  get(key: ChunkKey): Promise<Uint8Array | undefined>;
  deleteFile(sessionId: string, fileId: number): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export class StorageQuotaError extends Error {
  override name = 'StorageQuotaError';
}

const k = (key: ChunkKey) => `${key.sessionId}/${key.fileId}/${key.chunkIndex}`;

/** In-memory store. `quotaBytes` simulates a storage quota for tests and low-memory devices. */
export class MemoryChunkStore implements ChunkStore {
  private readonly map = new Map<string, Uint8Array>();
  private used = 0;

  constructor(private readonly quotaBytes = Number.POSITIVE_INFINITY) {}

  get usedBytes(): number {
    return this.used;
  }

  async put(key: ChunkKey, data: Uint8Array): Promise<void> {
    const id = k(key);
    const prev = this.map.get(id)?.length ?? 0;
    if (this.used - prev + data.length > this.quotaBytes) throw new StorageQuotaError('storage quota exceeded');
    this.map.set(id, data.slice());
    this.used += data.length - prev;
  }

  async get(key: ChunkKey): Promise<Uint8Array | undefined> {
    return this.map.get(k(key));
  }

  async deleteFile(sessionId: string, fileId: number): Promise<void> {
    this.deletePrefix(`${sessionId}/${fileId}/`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletePrefix(`${sessionId}/`);
  }

  /** Test hook: simulate eviction of one chunk. */
  evict(key: ChunkKey): void {
    const v = this.map.get(k(key));
    if (v) {
      this.used -= v.length;
      this.map.delete(k(key));
    }
  }

  private deletePrefix(prefix: string): void {
    for (const [id, v] of this.map) {
      if (id.startsWith(prefix)) {
        this.used -= v.length;
        this.map.delete(id);
      }
    }
  }
}
