/**
 * Frame scanning loop (spec §9.2–9.3): samples the live video at a controlled
 * rate, never runs more than one decode at a time, crops to the scan region,
 * downscales, and hands accepted packets to the caller.
 */
import { DecoderChain } from '../../qr/decoders/chain.ts';
import type { ScanHit } from '../../qr/decoders/types.ts';
import { decodePacket } from '../../protocol/packet.ts';
import { unframeScan } from '../../protocol/transport.ts';
import { ProtocolError } from '../../protocol/errors.ts';
import { scanRegion, targetScanSide, type ScanRegion } from './region.ts';

export interface ScannerOptions {
  /** Average upper bound on decode attempts per second. */
  maxFps?: number;
  /** Random source for scan-timing jitter (tests). */
  random?: () => number;
  /** Fraction of the video's shorter side covered by the scan square. */
  regionFraction?: number;
}

export interface ScannerStats {
  framesScanned: number;
  /** Frames where some decoder found a QR code (any content). */
  framesWithCode: number;
  /** Frames that produced an OptiSend packet with a valid header. */
  packets: number;
  /** QR codes that were not OptiSend packets (or had corrupt headers). */
  foreign: number;
  /** Recent decode rate. */
  fps: number;
  lastDecoder: string | null;
  lastVersion: number | null;
}

/**
 * Turn a decoder hit into packet bytes if it is an OptiSend packet whose
 * header passes structural + CRC validation. Payload hashes are checked later
 * by the receiver engine; this only filters foreign/garbled codes so the chain
 * can fall through to the next decoder.
 */
export function acceptHit(hit: ScanHit): Uint8Array | null {
  const pkt = unframeScan({ bytes: hit.bytes, text: hit.text });
  if (!pkt) return null;
  try {
    decodePacket(pkt);
    return pkt;
  } catch (e) {
    if (e instanceof ProtocolError) return null;
    throw e;
  }
}

/** ±25% random jitter on the gap between scan attempts. */
export const SCAN_JITTER = 0.25;

/**
 * Minimum gap before the next scan attempt: the nominal 1000/maxFps randomised by
 * ±SCAN_JITTER (mean unchanged). Without jitter, a 30 fps camera, a 12 scans/s cap
 * and a sender interval like 100 ms lock in phase, so every scan can land on the
 * same moment of each code — including the torn frame at a code change
 * (status/sendrate-benchmark.md).
 */
export function nextScanGap(maxFps: number, random: () => number = Math.random): number {
  return (1000 / maxFps) * (1 - SCAN_JITTER + 2 * SCAN_JITTER * random());
}

type VideoWithRvfc = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };

export class FrameScanner {
  private running = false;
  private busy = false;
  private handle: number | null = null;
  private lastAttempt = 0;
  private gap: number;
  private readonly random: () => number;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private readonly recent: number[] = [];
  private _region: ScanRegion | null = null;
  readonly stats: ScannerStats = { framesScanned: 0, framesWithCode: 0, packets: 0, foreign: 0, fps: 0, lastDecoder: null, lastVersion: null };
  private readonly maxFps: number;
  private readonly fraction: number;
  /** Index into the region cycle; sticks while codes are being found. */
  private regionMode = 0;
  private missesInMode = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly chain: DecoderChain,
    private readonly onPacket: (packet: Uint8Array, decoderId: string) => void,
    opts: ScannerOptions = {},
  ) {
    this.maxFps = opts.maxFps ?? 12;
    this.fraction = opts.regionFraction ?? 0.85;
    this.random = opts.random ?? Math.random;
    this.gap = nextScanGap(this.maxFps, this.random);
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  /** Current scan region in video pixels (for drawing the on-screen guide). */
  get region(): ScanRegion | null {
    return this._region;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      const v = this.video as VideoWithRvfc;
      if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.handle);
      else cancelAnimationFrame(this.handle);
      this.handle = null;
    }
  }

  private schedule(): void {
    if (!this.running) return;
    const v = this.video as VideoWithRvfc;
    // requestVideoFrameCallback fires once per *new* camera frame; rAF is the fallback.
    this.handle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => this.onFrame()) : requestAnimationFrame(() => this.onFrame());
  }

  private onFrame(): void {
    this.handle = null;
    if (!this.running) return;
    const now = performance.now();
    if (!this.busy && now - this.lastAttempt >= this.gap && this.video.readyState >= 2 && this.video.videoWidth > 0) {
      this.lastAttempt = now;
      this.gap = nextScanGap(this.maxFps, this.random);
      void this.scanOnce(now);
    }
    this.schedule();
  }

  private async scanOnce(now: number): Promise<void> {
    this.busy = true;
    try {
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      // Alternate between the guide square and the whole frame until a code is found,
      // so a phone held too close (code overflowing the guide) still scans.
      const fraction = this.regionMode === 0 ? this.fraction : 1;
      const r = scanRegion(vw, vh, fraction, targetScanSide(this.stats.lastVersion));
      this._region = r;
      if (this.canvas.width !== r.dSize) { this.canvas.width = r.dSize; this.canvas.height = r.dSize; }
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.drawImage(this.video, r.sx, r.sy, r.sSize, r.sSize, 0, 0, r.dSize, r.dSize);
      const img = this.ctx.getImageData(0, 0, r.dSize, r.dSize);
      this.stats.framesScanned++;
      this.recent.push(now);
      while (this.recent.length && now - this.recent[0]! > 2000) this.recent.shift();
      this.stats.fps = this.recent.length / 2;

      let sawCode = false;
      const res = await this.chain.decode({ data: img.data, width: img.width, height: img.height }, (hit) => {
        sawCode = true;
        return acceptHit(hit);
      });
      if (sawCode) this.stats.framesWithCode++;
      if (res || sawCode) this.missesInMode = 0;
      else if (++this.missesInMode >= 2) {
        this.missesInMode = 0;
        this.regionMode = (this.regionMode + 1) % 2;
      }
      if (res) {
        this.stats.packets++;
        this.stats.lastDecoder = res.decoderId;
        if (res.hit.version) this.stats.lastVersion = res.hit.version;
        if (this.running) this.onPacket(res.value, res.decoderId);
      } else if (sawCode) {
        this.stats.foreign++;
      }
    } catch {
      /* a failed frame is just a missed frame */
    } finally {
      this.busy = false;
    }
  }
}
