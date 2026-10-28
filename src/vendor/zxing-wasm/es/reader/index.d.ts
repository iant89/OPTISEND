/**
 * Minimal types for the parts of zxing-wasm's reader that OptiSend uses
 * (the upstream .d.ts files depend on type-fest and @types/emscripten).
 */
export interface Point { x: number; y: number }
export interface Position { topLeft: Point; topRight: Point; bottomRight: Point; bottomLeft: Point }

export interface ReadResult {
  isValid: boolean;
  error: string;
  format: string;
  /** Raw content bytes, without character-set conversion. */
  bytes: Uint8Array;
  text: string;
  position: Position;
  /** Symbol version as text, e.g. "25" for a version-25 QR code. */
  version: string;
}

export interface ReaderOptions {
  formats?: string[];
  tryHarder?: boolean;
  tryRotate?: boolean;
  tryInvert?: boolean;
  tryDownscale?: boolean;
  maxNumberOfSymbols?: number;
}

export interface ZXingModuleOverrides {
  /** Resolve the .wasm file's URL (default: the jsDelivr CDN). */
  locateFile?: (path: string, prefix: string) => string;
  /** The .wasm file's bytes, skipping the fetch entirely. */
  wasmBinary?: ArrayBuffer;
}

export function prepareZXingModule(options: { overrides?: ZXingModuleOverrides; fireImmediately: true }): Promise<unknown>;
export function prepareZXingModule(options?: { overrides?: ZXingModuleOverrides; fireImmediately?: false }): void;
export function readBarcodes(input: { data: Uint8ClampedArray; width: number; height: number }, readerOptions?: ReaderOptions): Promise<ReadResult[]>;
export const ZXING_WASM_VERSION: string;
export const ZXING_CPP_COMMIT: string;
/** SHA-256 (hex) of the .wasm file this module was built with. */
export const ZXING_WASM_SHA256: string;
