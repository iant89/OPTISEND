/** Message contracts shared by the main thread and the Web Workers. */
import type { EccLevel } from '../qr/capacity.ts';
import type { QrContent } from '../protocol/transport.ts';

export type HashRequest = { id: number; file: Blob };
export type HashResponse =
  | { id: number; kind: 'progress'; hashed: number }
  | { id: number; kind: 'done'; hash: Uint8Array }
  | { id: number; kind: 'error'; message: string };

export type QrRequest = { id: number; content: QrContent; ecc: EccLevel; minVersion: number; maskOffset?: number };
export type QrResponse =
  | { id: number; kind: 'done'; version: number; mask: number; size: number; modules: Uint8Array; ecc: EccLevel }
  | { id: number; kind: 'error'; message: string };

import type { ScanHit } from '../qr/decoders/types.ts';
export type ScanRequest = { id: number; data: Uint8ClampedArray; width: number; height: number };
export type ScanResponse = { id: number; hit: ScanHit | null };

export type ZxingInit = { kind: 'init'; wasmUrl: string };
export type ZxingStatus = { kind: 'ready' } | { kind: 'error'; message: string };
