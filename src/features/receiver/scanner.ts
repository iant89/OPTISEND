/**
 * Frame scanning loop (spec §9.2–9.3): looks at every camera frame, locates the
 * code in a half-size copy, crops around it (or to the scan region), skips frames
 * that duplicate the last decoded one, and decodes in a two-stage pipeline: the
 * next frame is captured while the previous one decodes, never more than one
 * waiting. Accepted packets go to the caller.
 */
import { DecoderChain } from '../../qr/decoders/chain.ts';
import type { ScanFrame, ScanHit } from '../../qr/decoders/types.ts';
import { decodePacket } from '../../protocol/packet.ts';
import { unframeScan } from '../../protocol/transport.ts';
import { ProtocolError } from '../../protocol/errors.ts';
import { locatorSide, regionForBox, scanRegion, targetScanSide, type ScanRegion } from './region.ts';
import { locateQr } from '../../qr/detect/finder.ts';
import { isColourFrame } from '../../qr/color.ts';
import { ColourSplitter } from '../../qr/colour-splitter.ts';
import { frameThumb, isSameFrame } from './dedupe.ts';

export interface ScannerOptions {
  /**
   * Average upper bound on scan attempts per second (default: none, every camera
   * frame). The old cap of 12/s suited jsQR's 30–50 ms decodes; with ZXing it
   * limited how fast the sender could go (bench/sendrate/REPORT.md).
   */
  maxFps?: number;
  /** Random source for scan-timing jitter (tests). */
  random?: () => number;
  /** Fraction of the video's shorter side covered by the scan square. */
  regionFraction?: number;
  /**
   * After a miss on a located code, decode the guide square next (default true).
   * Helps jsQR, whose failures depend on the crop; ZXing reads the tight crop
   * at least as well as the guide square, so it turns this off.
   */
  alternateGuide?: boolean;
  /** Skip frames that look the same as the last fully decoded one (default true). */
  dedupe?: boolean;
}

export interface ScannerStats {
  framesScanned: number;
  /** Frames where some decoder found a QR code (any content). */
  framesWithCode: number;
  /** Frames that produced an OptiSend packet with a valid header. */
  packets: number;
  /** QR codes that were not OptiSend packets (or had corrupt headers). */
  foreign: number;
  /** Frames where the locator found a code's three finder patterns. */
  framesLocated: number;
  /** Frames not decoded because the locator found no code. */
  framesSkipped: number;
  /** Frames not decoded because they duplicate the last fully decoded frame. */
  framesDuplicate: number;
  /** Decoded frames detected as colour (three codes, one per channel). */
  framesColour: number;
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

/** Which part of the frame to decode. */
export type CropKind = 'located' | 'guide' | 'frame';

/** On frames where the locator sees no code, still decode every n-th one, in case the locator missed it. */
export const UNLOCATED_DECODE_EVERY = 3;

export interface CropState {
  /** Consecutive located frames that produced no code. */
  locatedMisses: number;
  /** Consecutive frames where the locator found nothing. */
  unlocated: number;
  /** Consecutive fallback decodes (unlocated frames) that produced no code. */
  fallbackMisses: number;
}

/**
 * Choose the crop for this frame, or null to skip decoding it.
 *  - Code located: the tight crop around it. With `alternateGuide`, the guide
 *    square after each miss (jsQR's failures on different crops are largely
 *    independent, and dense codes sometimes decode only in the larger crop).
 *  - Nothing located: skip, except every UNLOCATED_DECODE_EVERY-th frame,
 *    which decodes the guide square, switching to the whole frame after two
 *    misses (the pre-locator behaviour), so a locator miss costs little.
 */
export function chooseCrop(located: boolean, st: CropState, alternateGuide = true): CropKind | null {
  if (located) return alternateGuide && st.locatedMisses % 2 === 1 ? 'guide' : 'located';
  if (st.unlocated % UNLOCATED_DECODE_EVERY !== 0) return null;
  return (st.fallbackMisses >> 1) % 2 === 0 ? 'guide' : 'frame';
}

type VideoWithRvfc = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };

/** A camera frame captured, located and cropped on the main thread, waiting to be decoded. */
interface Captured {
  frame: ScanFrame;
  located: boolean;
  colour: boolean;
  thumb: Float32Array;
}

export class FrameScanner {
  private running = false;
  private handle: number | null = null;
  private lastAttempt = 0;
  private gap: number;
  private readonly random: () => number;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private readonly locCanvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly locCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private readonly recent: number[] = [];
  private _region: ScanRegion | null = null;
  readonly stats: ScannerStats = { framesScanned: 0, framesWithCode: 0, packets: 0, foreign: 0, framesLocated: 0, framesSkipped: 0, framesDuplicate: 0, framesColour: 0, fps: 0, lastDecoder: null, lastVersion: null };
  private readonly maxFps: number;
  private readonly fraction: number;
  private readonly alternateGuide: boolean;
  private readonly dedupe: boolean;
  /** Colour-frame worker, started on the first colour frame. */
  private splitter: ColourSplitter | null = null;
  private readonly crop: CropState = { locatedMisses: 0, unlocated: 0, fallbackMisses: 0 };
  /** Pipeline: one frame decoding, at most one captured frame waiting (never a backlog). */
  private decoding = false;
  private waiting: Captured | null = null;
  /** Thumbnail of the last frame whose codes all decoded (duplicate check). */
  private lastDecoded: Float32Array | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly chain: DecoderChain,
    private readonly onPacket: (packet: Uint8Array, decoderId: string) => void,
    opts: ScannerOptions = {},
  ) {
    this.maxFps = opts.maxFps ?? Infinity;
    this.fraction = opts.regionFraction ?? 0.85;
    this.alternateGuide = opts.alternateGuide ?? true;
    this.dedupe = opts.dedupe ?? true;
    this.random = opts.random ?? Math.random;
    this.gap = nextScanGap(this.maxFps, this.random);
    [this.canvas, this.ctx] = readableCanvas();
    [this.locCanvas, this.locCtx] = readableCanvas();
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
    this.waiting = null;
    if (this.handle !== null) {
      const v = this.video as VideoWithRvfc;
      if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.handle);
      else cancelAnimationFrame(this.handle);
      this.handle = null;
    }
  }

  /** Stop scanning and release workers. */
  dispose(): void {
    this.stop();
    this.splitter?.dispose();
    this.splitter = null;
  }

  private schedule(): void {
    if (!this.running) return;
    const v = this.video as VideoWithRvfc;
    // requestVideoFrameCallback fires once per *new* camera frame; rAF is the fallback.
    this.handle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => this.onFrame()) : requestAnimationFrame(() => this.onFrame());
  }

  /**
   * Every camera frame: capture it unless a frame is already waiting for the
   * decoder. Capturing while the previous frame decodes overlaps main-thread
   * work with the decoder; the waiting slot holds one frame, so nothing queues.
   */
  private onFrame(): void {
    this.handle = null;
    if (!this.running) return;
    const now = performance.now();
    if (!this.waiting && now - this.lastAttempt >= this.gap && this.video.readyState >= 2 && this.video.videoWidth > 0) {
      this.lastAttempt = now;
      let c: Captured | null = null;
      try {
        c = this.capture(now);
      } catch {
        /* a failed capture is just a missed frame */
      }
      // A skipped frame (no code, or a duplicate) cost a few ms: look again on the next camera frame.
      this.gap = c ? nextScanGap(this.maxFps, this.random) : 0;
      if (c) {
        if (this.decoding) this.waiting = c;
        else void this.decodeLoop(c);
      }
    }
    this.schedule();
  }

  private async decodeLoop(first: Captured): Promise<void> {
    this.decoding = true;
    try {
      for (let c: Captured | null = first; c && this.running; c = this.waiting, this.waiting = null) {
        try {
          await this.decode(c);
        } catch {
          /* a failed frame is just a missed frame */
        }
      }
    } finally {
      this.decoding = false;
    }
  }

  /** Main thread: locate, crop, colour check and thumbnail. Null if there is nothing new to decode. */
  private capture(now: number): Captured | null {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const guide = scanRegion(vw, vh, this.fraction, targetScanSide(this.stats.lastVersion));
    this._region = guide;

    // Locate: whole frame at half size, read through the green channel.
    const scale = locatorSide(Math.min(vw, vh)) / Math.min(vw, vh);
    const lw = Math.max(1, Math.round(vw * scale));
    const lh = Math.max(1, Math.round(vh * scale));
    if (this.locCanvas.width !== lw || this.locCanvas.height !== lh) { this.locCanvas.width = lw; this.locCanvas.height = lh; }
    this.locCtx.imageSmoothingEnabled = true;
    this.locCtx.drawImage(this.video, 0, 0, lw, lh);
    const loc = locateQr({ data: this.locCtx.getImageData(0, 0, lw, lh).data, width: lw, height: lh, stride: 4 });
    if (loc) {
      this.stats.framesLocated++;
      this.crop.unlocated = 0;
    } else {
      this.crop.unlocated++;
    }
    const kind = chooseCrop(!!loc, this.crop, this.alternateGuide);
    if (!kind) {
      this.stats.framesSkipped++;
      return null;
    }
    const r =
      kind === 'located' && loc ? regionForBox({ ...loc.box, module: loc.module }, scale, vw, vh)
      : kind === 'guide' ? guide
      : scanRegion(vw, vh, 1, targetScanSide(this.stats.lastVersion));

    if (this.canvas.width !== r.dSize) { this.canvas.width = r.dSize; this.canvas.height = r.dSize; }
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.video, r.sx, r.sy, r.sSize, r.sSize, 0, 0, r.dSize, r.dSize);
    const img = this.ctx.getImageData(0, 0, r.dSize, r.dSize);
    const thumb = frameThumb(img.data, r.dSize);
    if (this.dedupe && this.lastDecoded && isSameFrame(thumb, this.lastDecoded)) {
      this.stats.framesDuplicate++;
      return null;
    }
    this.stats.framesScanned++;
    this.recent.push(now);
    while (this.recent.length && now - this.recent[0]! > 2000) this.recent.shift();
    this.stats.fps = this.recent.length / 2;
    const frame = { data: img.data, width: img.width, height: img.height };
    return { frame, located: !!loc, colour: isColourFrame(frame), thumb };
  }

  /** Decode a captured frame (decoders and colour split run in workers) and hand over accepted packets. */
  private async decode(c: Captured): Promise<void> {
    const full = c.frame;
    // A colour frame carries three codes, one per channel. The colour worker undoes the camera's
    // colour mixing (estimated from the frame itself) and splits the channels; each is decoded
    // as a grey image. A channel that fails after unmixing is retried raw.
    let attempts: (() => Promise<ScanFrame>)[][] = [[async () => full]];
    if (c.colour) {
      this.stats.framesColour++;
      this.splitter ??= new ColourSplitter();
      const splitter = this.splitter;
      const copy = { ...full, data: new Uint8ClampedArray(full.data) }; // kept for a raw split; `full` is transferred
      const first = await splitter.split(full, true);
      let raw: Promise<ScanFrame[]> | null = first.unmixed ? null : Promise.resolve(first.channels);
      const rawChannel = async (ch: number) => (await (raw ??= splitter.split(copy, false).then((r) => r.channels)))[ch]!;
      attempts = [0, 1, 2].map((ch) => (first.unmixed ? [async () => first.channels[ch]!, () => rawChannel(ch)] : [() => rawChannel(ch)]));
    }
    let sawCode = false, accepted = 0;
    for (const tries of attempts) {
      for (const part of tries) {
        let saw = false;
        const res = await this.chain.decode(await part(), (hit) => {
          saw = true;
          return acceptHit(hit);
        });
        sawCode ||= saw;
        if (res) {
          accepted++;
          this.stats.packets++;
          this.stats.lastDecoder = res.decoderId;
          if (res.hit.version) this.stats.lastVersion = res.hit.version;
          if (this.running) this.onPacket(res.value, res.decoderId);
          break;
        }
        if (saw) this.stats.foreign++;
      }
    }
    if (sawCode) this.stats.framesWithCode++;
    // Frames that look like this one are duplicates only once every code in it has decoded.
    if (accepted === attempts.length) this.lastDecoded = c.thumb;
    const found = accepted > 0 || sawCode;
    if (c.located) this.crop.locatedMisses = found ? 0 : this.crop.locatedMisses + 1;
    else this.crop.fallbackMisses = found ? 0 : this.crop.fallbackMisses + 1;
  }
}

function readableCanvas(): [HTMLCanvasElement | OffscreenCanvas, CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D] {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  return [canvas, ctx];
}
