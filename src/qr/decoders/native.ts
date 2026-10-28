/**
 * Native BarcodeDetector plug-in (Chrome on Android/ChromeOS/macOS, some others).
 * Fast, but returns text only: fine for text-safe (Base45) frames; binary
 * frames are corrupted and will be rejected by validation, letting the chain
 * fall through to a byte-capable decoder.
 */
import type { FrameDecoder, ScanFrame, ScanHit } from './types.ts';

interface DetectedBarcode { rawValue: string; cornerPoints?: { x: number; y: number }[] }
interface BarcodeDetectorLike { detect(src: ImageData): Promise<DetectedBarcode[]> }
interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

function ctor(): BarcodeDetectorCtor | null {
  return (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;
}

/** Resolves true if this browser has a BarcodeDetector that reads QR codes. */
export async function nativeQrSupported(): Promise<boolean> {
  const C = ctor();
  if (!C || typeof ImageData === 'undefined') return false;
  try {
    const formats = (await C.getSupportedFormats?.()) ?? [];
    return formats.includes('qr_code');
  } catch {
    return false;
  }
}

export class NativeQrDecoder implements FrameDecoder {
  readonly id = 'native';
  readonly label = 'Built-in (BarcodeDetector)';
  readonly binary = false;
  private readonly detector: BarcodeDetectorLike;

  constructor() {
    const C = ctor();
    if (!C) throw new Error('BarcodeDetector unavailable');
    this.detector = new C({ formats: ['qr_code'] });
  }

  async decode(frame: ScanFrame): Promise<ScanHit | null> {
    try {
      const found = await this.detector.detect(new ImageData(frame.data as Uint8ClampedArray<ArrayBuffer>, frame.width, frame.height));
      const b = found[0];
      if (!b) return null;
      return { text: b.rawValue, bytes: null, ...(b.cornerPoints ? { corners: b.cornerPoints } : {}) };
    } catch {
      return null;
    }
  }
}
