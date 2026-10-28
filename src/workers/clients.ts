/**
 * Promise-based clients for the workers, with transparent main-thread
 * fallback when module workers are unavailable (spec §4.2: "where supported").
 */
import { encodeQr, type QrMatrix } from '../qr/encoder.ts';
import { blobSource, hashSource } from '../protocol/source.ts';
import type { EccLevel } from '../qr/capacity.ts';
import type { QrContent } from '../protocol/transport.ts';
import type { HashRequest, HashResponse, QrRequest, QrResponse } from './messages.ts';

function tryWorker(name: string): Worker | null {
  try {
    if (typeof Worker === 'undefined') return null;
    return new Worker(new URL(`./${name}.js`, import.meta.url), { type: 'module', name });
  } catch {
    return null;
  }
}

let nextId = 1;

export class QrEncoderClient {
  private worker: Worker | null;
  private pending = new Map<number, { resolve: (m: QrMatrix) => void; reject: (e: Error) => void; req: QrRequest }>();

  constructor(useWorker = true) {
    this.worker = useWorker ? tryWorker('qr.worker') : null;
    if (this.worker) {
      this.worker.onmessage = (e: MessageEvent<QrResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.kind === 'done') p.resolve({ version: e.data.version, ecc: e.data.ecc, mask: e.data.mask, size: e.data.size, modules: e.data.modules });
        else p.reject(new Error(e.data.message));
      };
      this.worker.onerror = () => this.fallBack();
    }
  }

  get usingWorker(): boolean {
    return this.worker !== null;
  }

  encode(content: QrContent, ecc: EccLevel, minVersion: number, maskOffset = 0): Promise<QrMatrix> {
    if (!this.worker) return Promise.resolve().then(() => encodeQr(content, { ecc, minVersion, maskOffset }));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const req: QrRequest = { id, content, ecc, minVersion, maskOffset };
      this.pending.set(id, { resolve, reject, req });
      this.worker!.postMessage(req);
    });
  }

  /** Worker failed to load (e.g. CSP): finish outstanding jobs on the main thread. */
  private fallBack(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      try {
        p.resolve(encodeQr(p.req.content, { ecc: p.req.ecc, minVersion: p.req.minVersion, ...(p.req.maskOffset ? { maskOffset: p.req.maskOffset } : {}) }));
      } catch (e) {
        p.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}

export class HashClient {
  private worker: Worker | null;
  private pending = new Map<number, { resolve: (h: Uint8Array) => void; reject: (e: Error) => void; onProgress?: (n: number) => void; file: Blob }>();

  constructor(useWorker = true) {
    this.worker = useWorker ? tryWorker('hash.worker') : null;
    if (this.worker) {
      this.worker.onmessage = (e: MessageEvent<HashResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        if (e.data.kind === 'progress') { p.onProgress?.(e.data.hashed); return; }
        this.pending.delete(e.data.id);
        if (e.data.kind === 'done') p.resolve(e.data.hash);
        else p.reject(new Error(e.data.message));
      };
      this.worker.onerror = () => {
        this.worker?.terminate();
        this.worker = null;
        // Finish outstanding jobs on the main thread.
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          hashSource(blobSource(p.file), p.onProgress ? { onProgress: p.onProgress } : {}).then(p.resolve, p.reject);
        }
      };
    }
  }

  hash(file: Blob, onProgress?: (hashed: number) => void): Promise<Uint8Array> {
    if (!this.worker) return hashSource(blobSource(file), onProgress ? { onProgress } : {});
    const id = nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, file, ...(onProgress ? { onProgress } : {}) });
      const msg: HashRequest = { id, file };
      this.worker!.postMessage(msg);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
