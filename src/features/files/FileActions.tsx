import { useState } from 'react';
import type { FileSnapshot, ReceiverEngine } from '../../protocol/receiver.ts';
import { canSaveAs, canShareFiles, downloadBlob, saveAsStream, shareBlob, verifiedFileBlob } from './download.ts';
import { formatBytes } from '../../utils/format.ts';

interface Props {
  engine: ReceiverEngine;
  f: FileSnapshot;
  /** Show a Delete button (with confirmation). */
  allowDelete?: boolean;
}

/** Save / Save as… / Share / Delete for a verified file. */
export function FileActions({ engine, f, allowDelete = false }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const share = canShareFiles();
  const saveAs = canSaveAs();

  const run = async (how: 'download' | 'share' | 'save-as') => {
    setBusy(true);
    setError(null);
    try {
      if (how === 'save-as') {
        await saveAsStream(engine, f);
      } else {
        const blob = await verifiedFileBlob(engine, f.sessionId, f.fileId, f.mimeType);
        if (how === 'share') await shareBlob(blob, f.displayName);
        else downloadBlob(blob, f.displayName);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await engine.removeFile(f.sessionId, f.fileId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (confirming) {
    return (
      <div className="confirm-row" role="group" aria-label={`Confirm deleting ${f.displayName}`}>
        <span className="small">Delete {f.displayName} ({formatBytes(f.fileSize)}) from this device?</span>
        <div className="button-row">
          <button type="button" className="btn btn-destructive" disabled={busy} onClick={() => void remove()}>Delete</button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="button-row file-actions">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run('download')} aria-label={`Save ${f.displayName}`}>Save</button>
      {saveAs && <button type="button" className="btn" disabled={busy} onClick={() => void run('save-as')} aria-label={`Save ${f.displayName} as`}>Save as…</button>}
      {share && <button type="button" className="btn" disabled={busy} onClick={() => void run('share')} aria-label={`Share ${f.displayName}`}>Share…</button>}
      {allowDelete && <button type="button" className="btn btn-ghost btn-danger-text" disabled={busy} onClick={() => setConfirming(true)} aria-label={`Delete ${f.displayName}`}>Delete</button>}
      {error && <p className="error-text small" role="alert">{error}</p>}
    </div>
  );
}
