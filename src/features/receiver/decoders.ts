import { DecoderChain } from '../../qr/decoders/chain.ts';
import { JsQrDecoder } from '../../qr/decoders/jsqr.ts';
import { NativeQrDecoder, nativeQrSupported } from '../../qr/decoders/native.ts';
import type { FrameDecoder } from '../../qr/decoders/types.ts';

export type DecoderMode =
  /** Native first (fast, text-only) with jsQR fallback (handles binary). */
  | 'auto'
  | 'jsqr'
  | 'native'
  /** Run every available decoder on every frame and compare (diagnostics). */
  | 'compare';

export const DECODER_MODE_LABELS: Record<DecoderMode, string> = {
  auto: 'Automatic',
  jsqr: 'jsQR only',
  native: 'Built-in only',
  compare: 'Compare all (diagnostics)',
};

export async function buildDecoderChain(mode: DecoderMode): Promise<{ chain: DecoderChain; nativeAvailable: boolean }> {
  const nativeAvailable = await nativeQrSupported();
  const list: FrameDecoder[] = [];
  if (nativeAvailable && mode !== 'jsqr') list.push(new NativeQrDecoder());
  if (mode !== 'native' || !nativeAvailable) list.push(new JsQrDecoder());
  return { chain: new DecoderChain(list, mode === 'compare' ? 'all' : 'first'), nativeAvailable };
}
