import { DecoderChain } from '../../qr/decoders/chain.ts';
import { JsQrDecoder } from '../../qr/decoders/jsqr.ts';
import { NativeQrDecoder, nativeQrSupported } from '../../qr/decoders/native.ts';
import { ZxingDecoder } from '../../qr/decoders/zxing.ts';
import type { FrameDecoder } from '../../qr/decoders/types.ts';

export type DecoderMode =
  /** ZXing-C++ first (most reliable, handles binary), then the built-in detector; jsQR only if ZXing cannot load. */
  | 'auto'
  | 'zxing'
  | 'jsqr'
  | 'native'
  /** Run every available decoder on every frame and compare (diagnostics). */
  | 'compare';

export const DECODER_MODE_LABELS: Record<DecoderMode, string> = {
  auto: 'Automatic',
  zxing: 'ZXing only',
  jsqr: 'jsQR only',
  native: 'Built-in only',
  compare: 'Compare all (diagnostics)',
};

export const DECODER_MODES = Object.keys(DECODER_MODE_LABELS) as DecoderMode[];

export interface DecoderAvailability {
  native: boolean;
  zxing: boolean;
}

/**
 * Which decoders a mode uses, in chain order. A mode whose decoder is
 * unavailable falls back to jsQR, which always works.
 */
export function decoderIdsFor(mode: DecoderMode, has: DecoderAvailability): string[] {
  switch (mode) {
    case 'auto': {
      const ids = has.zxing ? ['zxing'] : [];
      if (has.native) ids.push('native');
      // jsQR never decoded a frame ZXing missed in simulation and costs ~45 ms per miss: keep it as the fallback only.
      if (!has.zxing) ids.push('jsqr');
      return ids;
    }
    case 'zxing':
      return has.zxing ? ['zxing'] : ['jsqr'];
    case 'native':
      return has.native ? ['native'] : ['jsqr'];
    case 'jsqr':
      return ['jsqr'];
    case 'compare':
      return [...(has.zxing ? ['zxing'] : []), ...(has.native ? ['native'] : []), 'jsqr'];
  }
}

export async function buildDecoderChain(mode: DecoderMode): Promise<{ chain: DecoderChain } & DecoderAvailability> {
  const zx = mode === 'auto' || mode === 'zxing' || mode === 'compare' ? new ZxingDecoder() : null;
  const [native, zxing] = await Promise.all([nativeQrSupported(), zx ? zx.ready : Promise.resolve(false)]);
  if (zx && !zxing) zx.dispose();
  const make: Record<string, () => FrameDecoder> = {
    zxing: () => zx!,
    native: () => new NativeQrDecoder(),
    jsqr: () => new JsQrDecoder(),
  };
  const list = decoderIdsFor(mode, { native, zxing }).map((id) => make[id]!());
  return { chain: new DecoderChain(list, mode === 'compare' ? 'all' : 'first'), native, zxing };
}
