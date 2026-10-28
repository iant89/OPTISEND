/**
 * ZXing-C++ (WebAssembly) wrapper, usable in workers, the main thread and tests.
 * The module must be loaded with loadZxing() before decodeWithZxing().
 */
import { prepareZXingModule, readBarcodes, type ReaderOptions } from '../../vendor/zxing-wasm/es/reader/index.js';
import type { ScanFrame, ScanHit } from './types.ts';

export type ZxingSource = { wasmUrl: string } | { wasmBinary: ArrayBuffer };

let loaded: Promise<void> | null = null;

/** Load and compile the module once. Never fetches from a CDN: the caller names the file or passes its bytes. */
export function loadZxing(src: ZxingSource): Promise<void> {
  loaded ??= prepareZXingModule({
    overrides: 'wasmBinary' in src ? { wasmBinary: src.wasmBinary } : { locateFile: () => src.wasmUrl },
    fireImmediately: true,
  }).then(
    () => undefined,
    (e: unknown) => {
      loaded = null;
      throw e;
    },
  );
  return loaded;
}

// OptiSend codes are always dark-on-light and upright on screen (any camera rotation is
// handled by finder geometry), so the inverted and rotated passes are skipped.
const OPTIONS: ReaderOptions = { formats: ['QRCode'], tryInvert: false, tryRotate: false, maxNumberOfSymbols: 1 };

export async function decodeWithZxing(frame: ScanFrame): Promise<ScanHit | null> {
  const r = (await readBarcodes(frame, OPTIONS)).find((x) => x.isValid);
  if (!r) return null;
  const p = r.position;
  const version = Number.parseInt(r.version, 10);
  return {
    text: r.text,
    bytes: r.bytes,
    ...(Number.isFinite(version) ? { version } : {}),
    corners: [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft],
  };
}
