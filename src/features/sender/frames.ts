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

/**
 * Mask rotation: pass 1 uses the encoder's automatic (lowest-penalty) mask; each later
 * pass shifts it by 3 (coprime to 8, so 8 passes visit every mask). The same packet
 * then has a different module pattern each pass — a code one decoder cannot read at a
 * given camera angle usually becomes readable on the next pass (status/sendrate-benchmark.md).
 */
export function maskOffsetForPass(pass: number): number {
  return (Math.max(0, pass - 1) * 3) % 8;
}

export class FrameRenderer {
  private readonly cache = new Map<string, Promise<QrMatrix>>();

  constructor(
    private readonly plan: TransferPlan,
    private readonly cfg: ResolvedQrConfig,
    private readonly encoder: QrEncoderClient,
    private readonly capacity = 16,
  ) {}

  get(ref: PacketRef, pass = 1): Promise<QrMatrix> {
    const offset = maskOffsetForPass(pass);
    const key = `${refKey(ref)}@${offset}`;
    const hit = this.cache.get(key);
    if (hit) {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const p = this.plan.packet(ref).then((packet) =>
      // Data frames always fit cfg.version exactly; an oversized manifest part gets a larger version.
      this.encoder.encode(frameForQr(packet, this.cfg.transport), this.cfg.ecc, this.cfg.version, offset),
    );
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, p);
    while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  prefetch(items: readonly { frame: PacketRef; pass: number }[]): void {
    for (const it of items) void this.get(it.frame, it.pass).catch(() => undefined);
  }

  /** Synchronously check whether a frame is already rendered. */
  has(ref: PacketRef, pass = 1): boolean {
    return this.cache.has(`${refKey(ref)}@${maskOffsetForPass(pass)}`);
  }
}
