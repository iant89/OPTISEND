/**
 * Runs decoder plug-ins over a frame and returns the first hit that the
 * caller's validator accepts (e.g. "unframes to an OptiSend packet with a
 * valid header"). Records per-decoder statistics for choosing defaults.
 */
import type { FrameDecoder, ScanFrame, ScanHit } from './types.ts';

export type ChainMode =
  /** Try decoders in order; stop at the first accepted hit. */
  | 'first'
  /** Run every decoder on every frame (diagnostics / comparison). */
  | 'all';

export interface DecoderStats {
  id: string;
  label: string;
  binary: boolean;
  attempts: number;
  /** Frames where the decoder found any QR code. */
  hits: number;
  /** Hits the validator accepted. */
  accepted: number;
  /** Accepted hits no earlier decoder in the chain produced (its unique contribution). */
  rescued: number;
  totalMs: number;
}

export interface ChainResult<T> {
  value: T;
  hit: ScanHit;
  decoderId: string;
}

export class DecoderChain {
  private readonly stats: Map<string, DecoderStats>;

  constructor(
    private decoders: FrameDecoder[],
    public mode: ChainMode = 'first',
    private readonly now: () => number = () => performance.now(),
  ) {
    this.stats = new Map(decoders.map((d) => [d.id, blank(d)]));
  }

  get ids(): string[] {
    return this.decoders.map((d) => d.id);
  }

  setDecoders(decoders: FrameDecoder[]): void {
    for (const d of this.decoders) if (!decoders.includes(d)) d.dispose?.();
    this.decoders = decoders;
    for (const d of decoders) if (!this.stats.has(d.id)) this.stats.set(d.id, blank(d));
  }

  snapshotStats(): DecoderStats[] {
    return this.decoders.map((d) => ({ ...this.stats.get(d.id)! }));
  }

  /**
   * Decode `frame`. `accept` turns a hit into a value (or null to reject it).
   * The frame may be consumed; it is copied for every decoder except the last.
   */
  async decode<T>(frame: ScanFrame, accept: (hit: ScanHit) => T | null): Promise<ChainResult<T> | null> {
    let result: ChainResult<T> | null = null;
    const n = this.decoders.length;
    for (let i = 0; i < n; i++) {
      const d = this.decoders[i]!;
      const s = this.stats.get(d.id)!;
      const input = i === n - 1 ? frame : { ...frame, data: new Uint8ClampedArray(frame.data) };
      const t0 = this.now();
      let hit: ScanHit | null = null;
      try {
        hit = await d.decode(input);
      } catch {
        hit = null;
      }
      s.attempts++;
      s.totalMs += this.now() - t0;
      if (!hit) continue;
      s.hits++;
      const value = accept(hit);
      if (value === null) continue;
      s.accepted++;
      if (!result) {
        if (i > 0) s.rescued++;
        result = { value, hit, decoderId: d.id };
      }
      if (this.mode === 'first') break;
    }
    return result;
  }

  dispose(): void {
    for (const d of this.decoders) d.dispose?.();
  }
}

function blank(d: FrameDecoder): DecoderStats {
  return { id: d.id, label: d.label, binary: d.binary, attempts: 0, hits: 0, accepted: 0, rescued: 0, totalMs: 0 };
}
