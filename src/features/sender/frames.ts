/**
 * Turns scheduler frame references into QR matrices: builds the packet, frames
 * it for the chosen transport and encodes it (in a worker when available).
 * Results are cached so prefetching the next frames makes swaps instantaneous.
 */

import type { PacketRef, TransferPlan } from '../../protocol/sender.ts';
import { frameForQr } from '../../protocol/transport.ts';
import type { QrMatrix } from '../../qr/encoder.ts';
import type { QrEncoderClient } from '../../workers/clients.ts';
import type { ResolvedQrConfig } from './settings.ts';

export function refKey(ref: PacketRef): string {
  return ref.kind === 'manifest' ? `m${ref.part}` : `d${ref.fileId}:${ref.chunkIndex}`;
}

export class FrameRenderer {
  private readonly cache = new Map<string, Promise<QrMatrix>>();

  constructor(
    private readonly plan: TransferPlan,
    private readonly cfg: ResolvedQrConfig,
    private readonly encoder: QrEncoderClient,
    private readonly capacity = 16,
  ) {}

  get(ref: PacketRef): Promise<QrMatrix> {
    const key = refKey(ref);
    const hit = this.cache.get(key);
    if (hit) {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const p = this.plan.packet(ref).then((packet) =>
      // Data frames always fit cfg.version exactly; an oversized manifest part gets a larger version.
      this.encoder.encode(frameForQr(packet, this.cfg.transport), this.cfg.ecc, this.cfg.version),
    );
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, p);
    while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  prefetch(refs: readonly PacketRef[]): void {
    for (const r of refs) void this.get(r).catch(() => undefined);
  }

  /** Synchronously check whether a frame is already rendered. */
  has(ref: PacketRef): boolean {
    return this.cache.has(refKey(ref));
  }
}
