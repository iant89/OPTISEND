/**
 * jsQR plug-in. Runs in a module worker when possible (frames are transferred,
 * not copied) and falls back to the main thread otherwise.
 */
import type { FrameDecoder, ScanFrame, ScanHit } from './types.ts';
import type { ScanRequest, ScanResponse } from '../../workers/messages.ts';

let seq = 1;

export class JsQrDecoder implements FrameDecoder {
  readonly id = 'jsqr';
  readonly label = 'jsQR';
  readonly binary = true;
  private worker: Worker | null = null;
  private pending = new Map<number, { resolve: (h: ScanHit | null) => void; frame: ScanFrame | null }>();

  constructor(useWorker = true) {
    if (!useWorker || typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(new URL('./scan.worker.js', import.meta.url), { type: 'module', name: 'scan.worker' });
      this.worker.onmessage = (e: MessageEvent<ScanResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        p.resolve(e.data.hit);
      };
      this.worker.onerror = () => {
        // Worker could not start (e.g. CSP): decode remaining requests on the main thread.
        this.worker?.terminate();
        this.worker = null;
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          if (p.frame) void safeDecode(p.frame).then(p.resolve);
          else p.resolve(null);
        }
      };
    } catch {
      this.worker = null;
    }
  }

  get usingWorker(): boolean {
    return this.worker !== null;
  }

  decode(frame: ScanFrame): Promise<ScanHit | null> {
    if (!this.worker) return safeDecode(frame);
    const id = seq++;
    return new Promise((resolve) => {
      // The buffer is transferred (zero-copy), so if the worker dies mid-request
      // this one frame is skipped; later frames decode on the main thread.
      this.pending.set(id, { resolve, frame: null });
      const req: ScanRequest = { id, data: frame.data, width: frame.width, height: frame.height };
      this.worker!.postMessage(req, [frame.data.buffer]);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
  }
}

// Main-thread fallback: loaded on demand so jsQR (≈120 KB) is not in the main bundle.
let core: Promise<typeof import('./jsqr-core.ts')> | null = null;
async function safeDecode(frame: ScanFrame): Promise<ScanHit | null> {
  try {
    core ??= import('./jsqr-core.ts');
    return (await core).decodeWithJsQr(frame);
  } catch {
    return null;
  }
}
