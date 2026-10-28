/**
 * Chunk geometry. Zero-based offsets, exclusive end (spec §6.3).
 *
 * An empty file is transmitted as exactly one zero-length chunk so that it
 * still produces a data packet and can complete without a manifest.
 */

export interface ChunkRange {
  index: number;
  start: number;
  /** Exclusive. */
  end: number;
  length: number;
}

export function expectedChunkCount(fileSize: number, chunkSize: number): number {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw new RangeError('fileSize must be a non-negative safe integer');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError('chunkSize must be a positive integer');
  return fileSize === 0 ? 1 : Math.ceil(fileSize / chunkSize);
}

export function chunkRange(fileSize: number, chunkSize: number, index: number): ChunkRange {
  const count = expectedChunkCount(fileSize, chunkSize);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError(`chunk index ${index} out of range [0, ${count})`);
  const start = index * chunkSize;
  const end = Math.min(start + chunkSize, fileSize);
  return { index, start, end, length: end - start };
}
