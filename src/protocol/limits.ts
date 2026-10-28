import { MAX_MIME_BYTES, MAX_NAME_BYTES } from './constants.ts';

/**
 * Resource limits enforced *before* any allocation, hashing or storage (spec §12.3).
 * QR codes are untrusted input; these bound what a hostile code can make us do.
 */
export interface ProtocolLimits {
  /** Largest file a receiver will accept. Default 8 GiB — far beyond practical QR throughput, not an arbitrary low cap. */
  maxFileSize: number;
  /** Max chunks per file. Bounds the chunk bitmap / fingerprint allocations. */
  maxChunkCount: number;
  /** Max total header length (relevant to manifests, whose entries live in the header). */
  maxHeaderLength: number;
  /** Max chunk payload length. QR v40-L tops out at 2,953 bytes, so 4,096 leaves headroom. */
  maxPayloadLength: number;
  maxNameBytes: number;
  maxMimeBytes: number;
  /** Max files a single session may declare. */
  maxFilesPerSession: number;
  /** Max concurrently tracked transfer sessions (receiver). */
  maxActiveSessions: number;
  /** Max files that are not yet verified, across all sessions (receiver). */
  maxIncompleteFiles: number;
}

export const DEFAULT_LIMITS: Readonly<ProtocolLimits> = Object.freeze({
  maxFileSize: 8 * 1024 ** 3,
  maxChunkCount: 1 << 24,
  maxHeaderLength: 4096,
  maxPayloadLength: 4096,
  maxNameBytes: MAX_NAME_BYTES,
  maxMimeBytes: MAX_MIME_BYTES,
  maxFilesPerSession: 1024,
  maxActiveSessions: 4,
  maxIncompleteFiles: 64,
});

export function resolveLimits(overrides?: Partial<ProtocolLimits>): ProtocolLimits {
  const l = { ...DEFAULT_LIMITS, ...overrides };
  // Never allow configuration to exceed what the wire format can express.
  l.maxNameBytes = Math.min(l.maxNameBytes, MAX_NAME_BYTES);
  l.maxMimeBytes = Math.min(l.maxMimeBytes, MAX_MIME_BYTES);
  l.maxPayloadLength = Math.min(l.maxPayloadLength, 0xffff);
  l.maxHeaderLength = Math.min(l.maxHeaderLength, 0xffff);
  l.maxFilesPerSession = Math.min(l.maxFilesPerSession, 0xffff);
  l.maxFileSize = Math.min(l.maxFileSize, Number.MAX_SAFE_INTEGER);
  return l;
}
