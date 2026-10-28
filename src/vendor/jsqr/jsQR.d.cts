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
export default jsQR;
