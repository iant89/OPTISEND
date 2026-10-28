/// <reference lib="webworker" />
/** Generates QR module matrices off the main thread (spec §4.2). */
import { encodeQr } from '../qr/encoder.ts';
import type { QrRequest, QrResponse } from './messages.ts';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<QrRequest>) => void) | null; postMessage(m: QrResponse, transfer?: Transferable[]): void };

ctx.onmessage = (e) => {
  const { id, content, ecc, minVersion } = e.data;
  try {
    const m = encodeQr(content, { ecc, minVersion });
    ctx.postMessage({ id, kind: 'done', version: m.version, mask: m.mask, size: m.size, modules: m.modules, ecc: m.ecc }, [m.modules.buffer]);
  } catch (err) {
    ctx.postMessage({ id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
