/**
 * Random-access byte sources so the sender never needs a whole file in one
 * contiguous buffer (spec §5.1, §11.3). A browser `File` is a `Blob`.
 */

import { Sha256 } from '../crypto/sha256.ts';

export interface ByteSource {
  readonly size: number;
  /** Read exactly `length` bytes at `offset` (caller guarantees the range is in bounds). */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  };
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

/** Streaming SHA-256 of a whole source with bounded memory. */
export async function hashSource(
  src: ByteSource,
  opts: { blockSize?: number; onProgress?: (hashedBytes: number) => void; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const blockSize = opts.blockSize ?? 4 * 1024 * 1024;
  const h = new Sha256();
  for (let off = 0; off < src.size; off += blockSize) {
    opts.signal?.throwIfAborted();
    const len = Math.min(blockSize, src.size - off);
    const block = await src.read(off, len);
    if (block.length !== len) throw new Error(`short read at ${off}: expected ${len}, got ${block.length}`);
    h.update(block);
    opts.onProgress?.(off + len);
  }
  return h.digest();
}
