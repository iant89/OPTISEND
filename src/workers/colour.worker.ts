/// <reference lib="webworker" />
/** Splits colour-layer QR frames into channels off the main thread (fit + per-pixel unmixing). */
import { splitColourFrame } from '../qr/color.ts';
import type { ColourSplitRequest, ColourSplitResponse } from './messages.ts';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<ColourSplitRequest>) => void) | null; postMessage(m: ColourSplitResponse, transfer: Transferable[]): void };

ctx.onmessage = (e) => {
  const { id, data, width, height, unmix } = e.data;
  const { channels, unmixed } = splitColourFrame({ data, width, height }, unmix);
  const bufs = channels.map((c) => c.data) as ColourSplitResponse['channels'];
  ctx.postMessage({ id, unmixed, channels: bufs }, bufs.map((b) => b.buffer));
};
