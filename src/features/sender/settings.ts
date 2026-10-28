/**
 * Sender settings and pre-transfer estimates (spec §3.2, §5.2). Pure functions,
 * no React — the estimate is available before any file is hashed.
 */

import { MANIFEST_FIXED_BYTES, MAX_MIME_BYTES } from '../../protocol/constants.ts';
import { expectedChunkCount } from '../../protocol/chunking.ts';
import { manifestEntrySize } from '../../protocol/packet.ts';
import { sanitizeFileName, truncateUtf8 } from '../../protocol/filename.ts';
import type { QrTransport } from '../../protocol/transport.ts';
import type { ScheduleStrategy } from '../../protocol/sender.ts';
import { maxChunkPayload, maxPacketBytes, PAYLOAD_PRESETS, type EccLevel, type PayloadPresetId } from '../../qr/capacity.ts';
import type { PassCount } from './scheduler.ts';

export type PresetChoice = PayloadPresetId | 'custom';

/**
 * QR codes per displayed frame. 3 = experimental colour mode: three codes
 * overlaid in the red, green and blue channels (file-list frames stay black
 * and white).
 */
export type ColorLayers = 1 | 3;

export interface SenderSettings {
  preset: PresetChoice;
  /** Used when preset === 'custom'. */
  customVersion: number;
  customEcc: EccLevel;
  /** Manual payload cap in bytes (custom only); 0 = fill the symbol. */
  customPayload: number;
  /** 'alphanumeric' = text-safe Base45 framing for decoders that only return text. */
  transport: QrTransport;
  intervalMs: number;
  passes: PassCount;
  strategy: ScheduleStrategy;
  /** Repeat the manifest after this many data frames (0 = only at the start of each pass). */
  manifestEvery: number;
  /** Show manifest frames for twice the interval. */
  holdManifest: boolean;
  colorLayers: ColorLayers;
  /**
   * From pass 2 on, send fountain-code repair symbols instead of repeating chunks
   * (PROTOCOL.md §5a): any repair symbol of a block fills any missing chunk of it.
   */
  fountain: boolean;
}

/**
 * 100 ms is the default: with ZXing and an uncapped, pipelined scanner the send-rate
 * benchmark (bench/sendrate/REPORT.md) captures every code in the first pass at 100 ms,
 * even with a dim-light 15 fps camera. 66 and 50 ms are faster still but need a
 * 30 fps camera and good light.
 */
export const INTERVAL_CHOICES = [50, 66, 100, 200, 300, 500, 750, 1000, 1500] as const;
/** Intervals below this need a 30 fps camera and good light (the UI says so). */
export const FAST_INTERVAL_MS = 100;
export const PASS_CHOICES: readonly PassCount[] = [1, 2, 3, 5, 'continuous'];

export const DEFAULT_SETTINGS: Readonly<SenderSettings> = Object.freeze({
  preset: 'conservative',
  customVersion: 20,
  customEcc: 'M',
  customPayload: 0,
  // Text-safe by default: works with every scanner, including text-only ones
  // (BarcodeDetector, OS camera apps) that corrupt binary byte-mode content.
  transport: 'alphanumeric',
  intervalMs: 100,
  passes: 'continuous',
  strategy: 'sequential',
  manifestEvery: 50,
  holdManifest: true,
  colorLayers: 1,
  fountain: true,
});

export interface ResolvedQrConfig {
  version: number;
  ecc: EccLevel;
  transport: QrTransport;
  chunkSize: number;
  maxPacketBytes: number;
}

export function resolveQrConfig(s: SenderSettings): ResolvedQrConfig {
  const base = s.preset === 'custom' ? { version: clampInt(s.customVersion, 1, 40), ecc: s.customEcc } : PAYLOAD_PRESETS[s.preset];
  const max = maxChunkPayload(base.version, base.ecc, s.transport);
  const chunkSize = s.preset === 'custom' && s.customPayload > 0 ? Math.min(max, Math.floor(s.customPayload)) : max;
  return { version: base.version, ecc: base.ecc, transport: s.transport, chunkSize, maxPacketBytes: maxPacketBytes(base.version, base.ecc, s.transport) };
}

export interface FileLike {
  name: string;
  size: number;
  /** MIME type (a browser File's `type`). */
  type?: string;
}

export interface TransferEstimate {
  /** False when the QR configuration cannot carry any payload. */
  valid: boolean;
  problem: string | null;
  chunkSize: number;
  dataFrames: number;
  manifestParts: number;
  /** Frames displayed in one pass, including manifest repeats (with colour layers, up to 3 data codes per frame). */
  framesPerPass: number;
  passMs: number;
  /** null for continuous mode. */
  totalMs: number | null;
  /** Payload throughput if every frame is captured. */
  bytesPerSecond: number;
  totalBytes: number;
}

/** Mirrors TransferPlan.pass() frame counting without hashing anything. */
export function estimateTransfer(files: readonly FileLike[], s: SenderSettings): TransferEstimate {
  const cfg = resolveQrConfig(s);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const empty: TransferEstimate = { valid: false, problem: null, chunkSize: cfg.chunkSize, dataFrames: 0, manifestParts: 0, framesPerPass: 0, passMs: 0, totalMs: 0, bytesPerSecond: 0, totalBytes };
  if (cfg.chunkSize < 1) return { ...empty, problem: `QR version ${cfg.version}-${cfg.ecc} is too small to carry a data packet. Choose a larger version.` };
  if (files.length === 0) return { ...empty, problem: null };

  const dataFrames = files.reduce((n, f) => n + expectedChunkCount(f.size, cfg.chunkSize), 0);
  // Manifest parts: greedy packing, same as buildManifestPackets.
  let parts = 0;
  let size = MANIFEST_FIXED_BYTES;
  let inPart = 0;
  for (const [i, f] of files.entries()) {
    const e = manifestEntrySize({ name: sanitizeFileName(f.name, `file-${i + 1}`), mimeType: truncateUtf8((f.type ?? '').trim(), MAX_MIME_BYTES) });
    if (inPart > 0 && size + e > cfg.maxPacketBytes) { parts++; size = MANIFEST_FIXED_BYTES; inPart = 0; }
    size += e;
    inPart++;
  }
  if (inPart > 0) parts++;

  const repeats = s.manifestEvery > 0 ? Math.floor(Math.max(0, dataFrames - 1) / s.manifestEvery) : 0;
  const manifestFrames = parts * (1 + repeats);
  // Data packets are packed per run between manifest repeats (see groupFrames).
  const layers = s.colorLayers;
  const dataShown = s.manifestEvery > 0
    ? repeats * Math.ceil(s.manifestEvery / layers) + Math.ceil((dataFrames - repeats * s.manifestEvery) / layers)
    : Math.ceil(dataFrames / layers);
  const framesPerPass = dataShown + manifestFrames;
  const passMs = (dataShown + manifestFrames * (s.holdManifest ? 2 : 1)) * s.intervalMs;
  return {
    valid: true,
    problem: null,
    chunkSize: cfg.chunkSize,
    dataFrames,
    manifestParts: parts,
    framesPerPass,
    passMs,
    totalMs: s.passes === 'continuous' ? null : passMs * s.passes,
    bytesPerSecond: passMs > 0 ? (totalBytes / passMs) * 1000 : 0,
    totalBytes,
  };
}

/** Parse untrusted persisted settings, falling back to defaults field by field. */
export function sanitizeSettings(raw: unknown): SenderSettings {
  const d = DEFAULT_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  const r = raw as Record<string, unknown>;
  const presets: PresetChoice[] = ['conservative', 'balanced', 'high-throughput', 'custom'];
  const eccs: EccLevel[] = ['L', 'M', 'Q', 'H'];
  return {
    preset: presets.includes(r.preset as PresetChoice) ? (r.preset as PresetChoice) : d.preset,
    customVersion: isInt(r.customVersion, 1, 40) ? (r.customVersion as number) : d.customVersion,
    customEcc: eccs.includes(r.customEcc as EccLevel) ? (r.customEcc as EccLevel) : d.customEcc,
    customPayload: isInt(r.customPayload, 0, 4096) ? (r.customPayload as number) : d.customPayload,
    transport: r.transport === 'alphanumeric' || r.transport === 'byte' ? r.transport : d.transport,
    intervalMs: isInt(r.intervalMs, 50, 10_000) ? (r.intervalMs as number) : d.intervalMs,
    passes: r.passes === 'continuous' || isInt(r.passes, 1, 1000) ? (r.passes as PassCount) : d.passes,
    strategy: r.strategy === 'round-robin' || r.strategy === 'sequential' ? r.strategy : d.strategy,
    manifestEvery: isInt(r.manifestEvery, 0, 100_000) ? (r.manifestEvery as number) : d.manifestEvery,
    holdManifest: typeof r.holdManifest === 'boolean' ? r.holdManifest : d.holdManifest,
    colorLayers: r.colorLayers === 3 ? 3 : 1,
    fountain: typeof r.fountain === 'boolean' ? r.fountain : d.fountain,
  };
}

function isInt(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)));
}

/** Earlier defaults for the time per code: 750 ms (settings v1), then 200 ms (v2). */
export const PREVIOUS_DEFAULT_INTERVALS: readonly number[] = [750, 200];

/**
 * Settings saved under an earlier default: keep the user's other choices, but an
 * interval equal to a previous default moves to the current default.
 */
export function migrateLegacySettings(raw: unknown): SenderSettings {
  const s = sanitizeSettings(raw);
  return PREVIOUS_DEFAULT_INTERVALS.includes(s.intervalMs) ? { ...s, intervalMs: DEFAULT_SETTINGS.intervalMs } : s;
}
