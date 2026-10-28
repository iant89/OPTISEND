import { createHash } from 'node:crypto';
import { prepareTransfer, type SendFileInput, type TransferPlan } from '../src/protocol/sender.ts';
import { bytesSource } from '../src/protocol/source.ts';

/** Deterministic pseudo-random bytes (xorshift32). */
export function makeBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

export function nodeSha256(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(b).digest());
}

export const SID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
export const SID_HEX = '0102030405060708';

export function seededShuffle<T>(arr: T[], seed = 7): T[] {
  const a = arr.slice();
  let x = seed;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export async function plan(
  files: { name: string; data: Uint8Array; mimeType?: string }[],
  chunkSize = 100,
  extra: { sessionId?: Uint8Array; maxManifestPacketBytes?: number } = {},
): Promise<TransferPlan> {
  const inputs: SendFileInput[] = files.map((f) => ({ name: f.name, source: bytesSource(f.data), ...(f.mimeType ? { mimeType: f.mimeType } : {}) }));
  return prepareTransfer(inputs, { chunkSize, maxManifestPacketBytes: extra.maxManifestPacketBytes ?? 1000, sessionId: extra.sessionId ?? SID });
}

/** All data packets of a plan, in sequential order. */
export async function allDataPackets(p: TransferPlan): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const f of p.files) for (let i = 0; i < f.chunkCount; i++) out.push(await p.dataPacket(f.fileId, i));
  return out;
}

export async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of gen) parts.push(c.slice());
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
