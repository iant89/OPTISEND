/// <reference lib="webworker" />
/** Decodes camera frames with jsQR off the main thread (spec §4.2, §9.3). */
import { decodeWithJsQr } from '../qr/decoders/jsqr-core.ts';
import type { ScanRequest, ScanResponse } from './messages.ts';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<ScanRequest>) => void) | null; postMessage(m: ScanResponse, transfer?: Transferable[]): void };

ctx.onmessage = (e) => {
  const { id, data, width, height } = e.data;
  let hit: ScanResponse['hit'] = null;
  try {
    hit = decodeWithJsQr({ data, width, height });
  } catch {
    hit = null;
  }
  ctx.postMessage({ id, hit }, hit?.bytes ? [hit.bytes.buffer] : []);
};
