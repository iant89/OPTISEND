/// <reference lib="webworker" />
/** Decodes camera frames with ZXing-C++ (WebAssembly) off the main thread. */
import { decodeWithZxing, loadZxing } from '../qr/decoders/zxing-core.ts';
import type { ScanRequest, ScanResponse, ZxingInit, ZxingStatus } from './messages.ts';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<ScanRequest | ZxingInit>) => void) | null; postMessage(m: ScanResponse | ZxingStatus, transfer?: Transferable[]): void };

ctx.onmessage = async (e) => {
  const msg = e.data;
  if ('kind' in msg) {
    try {
      await loadZxing({ wasmUrl: msg.wasmUrl });
      ctx.postMessage({ kind: 'ready' });
    } catch (err) {
      ctx.postMessage({ kind: 'error', message: String(err) });
    }
    return;
  }
  let hit: ScanResponse['hit'] = null;
  try {
    hit = await decodeWithZxing({ data: msg.data, width: msg.width, height: msg.height });
  } catch {
    hit = null;
  }
  // The result's bytes view WASM memory; copy before transferring.
  if (hit?.bytes) hit = { ...hit, bytes: hit.bytes.slice() };
  ctx.postMessage({ id: msg.id, hit }, hit?.bytes ? [hit.bytes.buffer] : []);
};
