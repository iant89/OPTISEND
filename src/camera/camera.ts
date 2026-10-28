/**
 * Camera access (spec §9.1): rear camera preferred, clear error states,
 * best-effort continuous focus, and explicit track cleanup.
 */

export type CameraErrorKind = 'insecure-context' | 'unsupported' | 'denied' | 'not-found' | 'in-use' | 'overconstrained' | 'unknown';

export class CameraError extends Error {
  override name = 'CameraError';
  constructor(readonly kind: CameraErrorKind, message: string) {
    super(message);
  }
}

export function describeCameraError(kind: CameraErrorKind): { title: string; help: string } {
  switch (kind) {
    case 'insecure-context':
      return { title: 'Camera needs a secure page', help: 'Open OptiSend over https:// (or on localhost). Browsers only allow camera access on secure pages.' };
    case 'unsupported':
      return { title: 'Camera not supported', help: 'This browser cannot access the camera. Try a recent Safari, Chrome, Edge or Firefox.' };
    case 'denied':
      return { title: 'Camera permission denied', help: 'Allow camera access for this site in your browser settings (on iPhone: Settings → Safari → Camera), then try again.' };
    case 'not-found':
      return { title: 'No camera found', help: 'This device does not report a camera. Connect one or use another device to receive.' };
    case 'in-use':
      return { title: 'Camera is busy', help: 'Another app or tab is using the camera. Close it and try again.' };
    case 'overconstrained':
      return { title: 'Camera settings not supported', help: 'The camera could not start with the requested settings. Try again; OptiSend will use simpler settings.' };
    default:
      return { title: 'Camera could not start', help: 'Something went wrong starting the camera. Try again, or reload the page.' };
  }
}

export function classifyCameraError(e: unknown): CameraError {
  if (e instanceof CameraError) return e;
  const name = (e as { name?: string } | null)?.name ?? '';
  const msg = (e as { message?: string } | null)?.message ?? String(e);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CameraError('denied', msg);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraError('not-found', msg);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('in-use', msg);
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new CameraError('overconstrained', msg);
    case 'TypeError':
    case 'NotSupportedError':
      return new CameraError('unsupported', msg);
    default:
      return new CameraError('unknown', msg);
  }
}

export interface OpenCameraOptions {
  deviceId?: string;
  /** Ideal capture size; dense QR codes benefit from 1080p. */
  idealWidth?: number;
  idealHeight?: number;
}

export async function openCamera(opts: OpenCameraOptions = {}): Promise<MediaStream> {
  if (typeof window !== 'undefined' && !window.isSecureContext) throw new CameraError('insecure-context', 'not a secure context');
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.getUserMedia) throw new CameraError('unsupported', 'mediaDevices.getUserMedia unavailable');

  const video: MediaTrackConstraints = {
    width: { ideal: opts.idealWidth ?? 1920 },
    height: { ideal: opts.idealHeight ?? 1080 },
    frameRate: { ideal: 30 },
    ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : { facingMode: { ideal: 'environment' } }),
  };
  let stream: MediaStream;
  try {
    stream = await md.getUserMedia({ video, audio: false });
  } catch (e) {
    const err = classifyCameraError(e);
    if (err.kind !== 'overconstrained') throw err;
    // Retry with the loosest request before giving up.
    try {
      stream = await md.getUserMedia({ video: true, audio: false });
    } catch (e2) {
      throw classifyCameraError(e2);
    }
  }
  await tryContinuousFocus(stream);
  return stream;
}

async function tryContinuousFocus(stream: MediaStream): Promise<void> {
  const track = stream.getVideoTracks()[0];
  if (!track?.getCapabilities) return;
  try {
    const caps = track.getCapabilities() as MediaTrackCapabilities & { focusMode?: string[] };
    if (caps.focusMode?.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
    }
  } catch {
    /* focus control is optional */
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}
