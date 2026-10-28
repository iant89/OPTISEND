export interface Point { x: number; y: number }
export interface QRCode {
  binaryData: number[];
  data: string;
  chunks: unknown[];
  version: number;
  location: {
    topRightCorner: Point; topLeftCorner: Point; bottomRightCorner: Point; bottomLeftCorner: Point;
    topRightFinderPattern: Point; topLeftFinderPattern: Point; bottomLeftFinderPattern: Point; bottomRightAlignmentPattern?: Point;
  };
}
export interface Options { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }
declare function jsQR(data: Uint8ClampedArray, width: number, height: number, options?: Options): QRCode | null;
declare namespace jsQR {
  /** [OptiSend addition] Decode from a luminance plane (width*height bytes), skipping RGBA→grey. */
  function luminance(luma: Uint8ClampedArray, width: number, height: number, options?: Options): QRCode | null;
}
export default jsQR;
