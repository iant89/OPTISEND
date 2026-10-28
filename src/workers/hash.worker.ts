/// <reference lib="webworker" />
/** Hashes selected files off the main thread with bounded memory (spec §4.2). */
import { blobSource, hashSource } from '../protocol/source.ts';
import type { HashRequest, HashResponse } from './messages.ts';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<HashRequest>) => void) | null; postMessage(m: HashResponse): void };

ctx.onmessage = async (e) => {
  const { id, file } = e.data;
  try {
    let last = 0;
    const hash = await hashSource(blobSource(file), {
      onProgress: (n) => {
        const now = Date.now();
        if (now - last > 100) { last = now; ctx.postMessage({ id, kind: 'progress', hashed: n }); }
      },
    });
    ctx.postMessage({ id, kind: 'done', hash });
  } catch (err) {
    ctx.postMessage({ id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
