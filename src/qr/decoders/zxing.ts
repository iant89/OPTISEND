/**
 * ZXing-C++ (WebAssembly) plug-in. Runs in a module worker when possible
 * (frames are transferred, not copied) and falls back to the main thread
 * otherwise. `ready` resolves false if the module cannot load (no
 * WebAssembly, blocked by CSP, missing file), so the chain can use jsQR instead.
 */
import type { FrameDecoder, ScanFrame, ScanHit } from './types.ts';
import type { ScanRequest, ScanResponse, ZxingInit, ZxingStatus } from '../../workers/messages.ts';

let seq = 1;

/** How long to wait for the module before giving up on it (≈1 MB, normally cached). */
export const ZXING_LOAD_TIMEOUT_MS = 8000;

export class ZxingDecoder implements FrameDecoder {
  readonly id = 'zxing';
  readonly label = 'ZXing-C++';
  readonly binary = true;
  readonly ready: Promise<boolean>;
  private worker: Worker | null = null;
  private pending = new Map<number, (h: ScanHit | null) => void>();
  private readonly wasmUrl = new URL('./zxing_reader.wasm', import.meta.url).href;

  constructor(useWorker = true) {
    this.ready = withTimeout(useWorker && typeof Worker !== 'undefined' ? this.startWorker() : this.loadHere(), ZXING_LOAD_TIMEOUT_MS);
  }

  get usingWorker(): boolean {
    return this.worker !== null;
  }

  private startWorker(): Promise<boolean> {
    let w: Worker;
    try {
      w = new Worker(new URL('./zxing.worker.js', import.meta.url), { type: 'module', name: 'zxing.worker' });
    } catch {
      return this.loadHere();
    }
    this.worker = w;
    return new Promise((resolve) => {
      w.onmessage = (e: MessageEvent<ScanResponse | ZxingStatus>) => {
        const m = e.data;
        if ('kind' in m) {
          if (m.kind === 'ready') resolve(true);
          else this.dropWorker().then(resolve, () => resolve(false));
          return;
        }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        p(m.hit);
      };
      // Worker could not start (e.g. CSP): try the main thread.
      w.onerror = () => void this.dropWorker().then(resolve, () => resolve(false));
      const init: ZxingInit = { kind: 'init', wasmUrl: this.wasmUrl };
      w.postMessage(init);
    });
  }

  private async dropWorker(): Promise<boolean> {
    this.worker?.terminate();
    this.worker = null;
    // Frames in flight were transferred to the dead worker: report them as misses.
    for (const p of this.pending.values()) p(null);
    this.pending.clear();
    return this.loadHere();
  }

  private async loadHere(): Promise<boolean> {
    try {
      await (await core()).loadZxing({ wasmUrl: this.wasmUrl });
      return true;
    } catch {
      return false;
    }
  }

  async decode(frame: ScanFrame): Promise<ScanHit | null> {
    if (!(await this.ready)) return null;
    if (!this.worker) {
      try {
        return await (await core()).decodeWithZxing(frame);
      } catch {
        return null;
      }
    }
    const id = seq++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      const req: ScanRequest = { id, data: frame.data, width: frame.width, height: frame.height };
      this.worker!.postMessage(req, [frame.data.buffer]);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p(null);
    this.pending.clear();
  }
}

// Main-thread fallback: loaded on demand so the WebAssembly glue is not in the main bundle.
let corePromise: Promise<typeof import('./zxing-core.ts')> | null = null;
function core(): Promise<typeof import('./zxing-core.ts')> {
  corePromise ??= import('./zxing-core.ts');
  return corePromise;
}

function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(false); },
    );
  });
}
