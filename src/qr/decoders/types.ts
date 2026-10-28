/**
 * QR decoder plug-in contract. Every decoder (native BarcodeDetector, jsQR,
 * and later OptiSend's own) implements FrameDecoder; the DecoderChain decides
 * which run on each camera frame and records per-decoder statistics so the
 * default can be chosen from real-device measurements.
 */

/** An RGBA frame (same layout as ImageData). */
export interface ScanFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Point { x: number; y: number }

export interface ScanHit {
  /** Text content, when the decoder provides it. */
  text: string | null;
  /** Raw segment bytes, when the decoder provides them (needed for binary transport). */
  bytes: Uint8Array | null;
  /** QR version, if known. */
  version?: number;
  /** Corners in frame coordinates (TL, TR, BR, BL), if known. */
  corners?: Point[];
}

export interface FrameDecoder {
  /** Stable id used in stats and settings, e.g. "native", "jsqr", "optisend". */
  readonly id: string;
  readonly label: string;
  /** True if hits carry exact raw bytes (binary transport works). */
  readonly binary: boolean;
  /**
   * Decode one frame. The decoder may take ownership of `frame.data`
   * (e.g. transfer it to a worker); the chain copies frames when needed.
   */
  decode(frame: ScanFrame): Promise<ScanHit | null>;
  dispose?(): void;
}
