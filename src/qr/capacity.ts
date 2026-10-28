/**
 * QR Code capacity (ISO/IEC 18004) for versions 1–40 at ECC levels L/M/Q/H,
 * plus OptiSend payload presets.
 *
 * Capacities are *computed* from the standard's block structure rather than
 * transcribed, and cross-checked against an independent encoder by
 * scripts/verify_qr_capacity.py (OpenCV) and against well-known reference
 * values in the tests (e.g. v40-L = 2,953 bytes / 4,296 alphanumeric).
 *
 * These are theoretical ceilings. Practical limits depend on display, camera,
 * distance and glare and must be established by calibration (spec §5.2–5.3).
 */

import { DATA_HEADER_BYTES } from '../protocol/constants.ts';
import { maxPacketForCapacity, type QrTransport } from '../protocol/transport.ts';

export type EccLevel = 'L' | 'M' | 'Q' | 'H';
export const ECC_LEVELS: readonly EccLevel[] = ['L', 'M', 'Q', 'H'];
export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

// Index 0 unused. Source: ISO/IEC 18004:2015 Table 9.
export const ECC_CODEWORDS_PER_BLOCK: Record<EccLevel, readonly number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
export const NUM_ECC_BLOCKS: Record<EccLevel, readonly number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < MIN_VERSION || version > MAX_VERSION) throw new RangeError(`QR version must be 1..40 (got ${version})`);
}

/** Modules available for data + ECC after function patterns are removed. */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function dataCodewords(version: number, ecc: EccLevel): number {
  assertVersion(version);
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[ecc][version]! * NUM_ECC_BLOCKS[ecc][version]!;
}

/** Max bytes in a single byte-mode segment. */
export function byteCapacity(version: number, ecc: EccLevel): number {
  const bits = dataCodewords(version, ecc) * 8 - 4 - (version <= 9 ? 8 : 16);
  return Math.floor(bits / 8);
}

/** Max characters in a single alphanumeric-mode segment. */
export function alphanumericCapacity(version: number, ecc: EccLevel): number {
  const ccBits = version <= 9 ? 9 : version <= 26 ? 11 : 13;
  const bits = dataCodewords(version, ecc) * 8 - 4 - ccBits;
  return Math.floor(bits / 11) * 2 + (bits % 11 >= 6 ? 1 : 0);
}

export function qrCapacity(version: number, ecc: EccLevel, transport: QrTransport): number {
  return transport === 'byte' ? byteCapacity(version, ecc) : alphanumericCapacity(version, ecc);
}

/** Largest OptiSend packet (header + payload) that fits the given QR configuration. */
export function maxPacketBytes(version: number, ecc: EccLevel, transport: QrTransport): number {
  return maxPacketForCapacity(qrCapacity(version, ecc, transport), transport);
}

/** Largest chunk payload for a data packet in the given QR configuration (0 if none fits). */
export function maxChunkPayload(version: number, ecc: EccLevel, transport: QrTransport): number {
  return Math.max(0, maxPacketBytes(version, ecc, transport) - DATA_HEADER_BYTES);
}

/** Smallest version that holds `packetBytes`, or null if even v40 cannot. */
export function smallestVersionFor(packetBytes: number, ecc: EccLevel, transport: QrTransport): number | null {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) if (maxPacketBytes(v, ecc, transport) >= packetBytes) return v;
  return null;
}

/** Number of modules along one side (excluding quiet zone). */
export function moduleCount(version: number): number {
  assertVersion(version);
  return 17 + 4 * version;
}

// ─────────────────────────── Presets ───────────────────────────

export type PayloadPresetId = 'conservative' | 'balanced' | 'high-throughput';

export interface QrConfig {
  version: number;
  ecc: EccLevel;
  transport: QrTransport;
  /** Chunk payload size; must be <= maxChunkPayload(version, ecc, transport). */
  chunkSize: number;
}

export interface PayloadPreset extends QrConfig {
  id: PayloadPresetId;
  label: string;
  description: string;
}

function preset(id: PayloadPresetId, label: string, description: string, version: number, ecc: EccLevel, transport: QrTransport): PayloadPreset {
  return { id, label, description, version, ecc, transport, chunkSize: maxChunkPayload(version, ecc, transport) };
}

/**
 * Starting points pending real-device calibration (spec §5.2). The chunk size
 * fills the chosen symbol exactly so every data QR has a fixed version and
 * therefore a stable module size on screen.
 */
export const PAYLOAD_PRESETS: Readonly<Record<PayloadPresetId, PayloadPreset>> = Object.freeze({
  conservative: preset('conservative', 'Conservative', 'Version 15 · ECC M — large modules, scans reliably on most phones', 15, 'M', 'byte'),
  balanced: preset('balanced', 'Balanced', 'Version 25 · ECC M — about 3× faster; needs a steady camera held close to the screen', 25, 'M', 'byte'),
  'high-throughput': preset('high-throughput', 'High throughput', 'Version 40 · ECC L — experimental: phone cameras usually cannot read it yet', 40, 'L', 'byte'),
});

/** Validate a manual configuration (spec §5.2: never exceed the selected QR capacity). */
export function validateQrConfig(c: QrConfig): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(c.version) || c.version < MIN_VERSION || c.version > MAX_VERSION) {
    errors.push('version must be an integer 1–40');
    return errors;
  }
  if (!ECC_LEVELS.includes(c.ecc)) errors.push('ecc must be L, M, Q or H');
  const max = maxChunkPayload(c.version, c.ecc, c.transport);
  if (!Number.isInteger(c.chunkSize) || c.chunkSize < 1) errors.push('chunkSize must be a positive integer');
  else if (c.chunkSize > max) errors.push(`chunkSize ${c.chunkSize} exceeds capacity ${max} for v${c.version}-${c.ecc} (${c.transport})`);
  return errors;
}
