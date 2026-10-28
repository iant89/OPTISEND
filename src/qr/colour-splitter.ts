/**
 * Runs the colour-frame split (src/qr/color.ts: fit the camera's colour mixing,
 * undo it, split into three grey channel frames) in a module worker, so the
 * 20–60 ms per colour frame stays off the main thread. Frames are transferred,
 * not copied. Falls back to the main thread if the worker cannot start.
 */
import type { ScanFrame } from './decoders/types.ts';
import { splitColourFrame } from './color.ts';
import type { ColourSplitRequest, ColourSplitResponse } from '../workers/messages.ts';

export interface ColourSplit {
  channels: [ScanFrame, ScanFrame, ScanFrame];
  unmixed: boolean;
}

let seq = 1;

export class ColourSplitter {
  private worker: Worker | null = null;
  private pending = new Map<number, { resolve: (r: ColourSplit) => void; reject: (e: Error) => void; width: number; height: number }>();

  constructor(useWorker = true) {
    if (!useWorker || typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(new URL('./colour.worker.js', import.meta.url), { type: 'module', name: 'colour.worker' });
      this.worker.onmessage = (e: MessageEvent<ColourSplitResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        const ch = e.data.channels.map((data) => ({ data, width: p.width, height: p.height })) as ColourSplit['channels'];
        p.resolve({ channels: ch, unmixed: e.data.unmixed });
      };
      // Worker could not start (e.g. CSP): in-flight frames were transferred to it and are lost; later ones split here.
      this.worker.onerror = () => {
        this.worker?.terminate();
        this.worker = null;
        for (const p of this.pending.values()) p.reject(new Error('colour worker failed'));
        this.pending.clear();
      };
    } catch {
      this.worker = null;
    }
  }

  get usingWorker(): boolean {
    return this.worker !== null;
  }

  /** Split `frame` (its buffer is transferred to the worker: do not use it afterwards). */
  async split(frame: ScanFrame, unmix: boolean): Promise<ColourSplit> {
    if (!this.worker) return splitColourFrame(frame, unmix);
    const id = seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, width: frame.width, height: frame.height });
      const req: ColourSplitRequest = { id, data: frame.data, width: frame.width, height: frame.height, unmix };
      this.worker!.postMessage(req, [frame.data.buffer]);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('disposed'));
    this.pending.clear();
  }
}

