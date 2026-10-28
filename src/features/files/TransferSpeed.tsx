import type { FileSnapshot } from '../../protocol/receiver.ts';
import { formatDuration, formatRate } from '../../utils/format.ts';

/** Human-readable per-file timing line (first captured chunk → verified, active scanning time only). */
export function describeTiming(f: Pick<FileSnapshot, 'status' | 'timing'>): string | null {
  const t = f.timing;
  if (t.startedAt === null) return null;
  const time = t.elapsedMs < 1000 ? 'under 1s' : formatDuration(t.elapsedMs);
  if (f.status === 'verified') {
    return t.bytesPerSecond === null ? `Received instantly (${time})` : `Received in ${time} · ${formatRate(t.bytesPerSecond)}`;
  }
  if (f.status === 'hash-mismatch') return `Stopped after ${time} — failed verification`;
  return t.bytesPerSecond === null ? `Receiving for ${time}` : `Receiving for ${time} · ${formatRate(t.bytesPerSecond)}`;
}

export function TransferSpeed({ f }: { f: Pick<FileSnapshot, 'status' | 'timing'> }) {
  const text = describeTiming(f);
  if (!text) return null;
  return (
    <p className={`speed small ${f.status === 'verified' ? 'speed-final' : 'muted'}`} title="Measured from this file's first captured code until it was verified, counting only time spent scanning">
      {text}
    </p>
  );
}
