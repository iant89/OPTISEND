import { useState } from 'react';
import type { FileSnapshot, ReceiverEngine } from '../../protocol/receiver.ts';
import { canShareFiles, downloadBlob, shareBlob, verifiedFileBlob } from './download.ts';

/** Save / Share buttons for a verified file. */
export function FileActions({ engine, f }: { engine: ReceiverEngine; f: FileSnapshot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const share = canShareFiles();

  const run = async (how: 'download' | 'share') => {
    setBusy(true);
    setError(null);
    try {
      const blob = await verifiedFileBlob(engine, f.sessionId, f.fileId, f.mimeType);
      if (how === 'share') await shareBlob(blob, f.displayName);
      else downloadBlob(blob, f.displayName);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="button-row file-actions">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run('download')} aria-label={`Save ${f.displayName}`}>Save</button>
      {share && <button type="button" className="btn" disabled={busy} onClick={() => void run('share')} aria-label={`Share ${f.displayName}`}>Share…</button>}
      {error && <p className="error-text small" role="alert">{error}</p>}
    </div>
  );
}
