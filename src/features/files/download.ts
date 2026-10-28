/**
 * Save verified files (spec §11.1). Object URL + <a download> everywhere;
 * the Web Share API (with files) is offered where available, which is the
 * most reliable way to put a file into Files/Photos on iOS.
 */
import type { ReceiverEngine } from '../../protocol/receiver.ts';
import { sanitizeFileName } from '../../protocol/filename.ts';

/** Only pass through well-formed MIME types; never let a sender force inline HTML rendering. */
export function safeMimeType(mime: string | null | undefined): string {
  const m = (mime ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(m)) return 'application/octet-stream';
  if (m === 'text/html' || m === 'application/xhtml+xml' || m === 'image/svg+xml') return 'application/octet-stream';
  return m;
}

export async function verifiedFileBlob(engine: ReceiverEngine, sessionId: string, fileId: number, mime: string | null): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of engine.readFile(sessionId, fileId)) parts.push(chunk.slice() as Uint8Array<ArrayBuffer>);
  return new Blob(parts, { type: safeMimeType(mime) });
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeFileName(name);
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before releasing memory.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFiles(): boolean {
  try {
    const probe = new File([new Uint8Array(1)], 'probe.bin', { type: 'application/octet-stream' });
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export async function shareBlob(blob: Blob, name: string): Promise<'shared' | 'cancelled'> {
  const file = new File([blob], sanitizeFileName(name), { type: blob.type });
  try {
    await navigator.share({ files: [file], title: file.name });
    return 'shared';
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return 'cancelled';
    throw e;
  }
}
