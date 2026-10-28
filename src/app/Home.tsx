import { useEffect, useState } from 'react';
import type { FileSnapshot, ReceiverEngine, SessionSnapshot } from '../protocol/receiver.ts';
import { ReceiverStorage, type StorageEstimateInfo } from '../storage/persistence.ts';
import { FileActions } from '../features/files/FileActions.tsx';
import { TransferSpeed } from '../features/files/TransferSpeed.tsx';
import { useEngineSnapshot } from '../hooks/useEngineSnapshot.ts';
import { formatBytes, pluralize } from '../utils/format.ts';

interface Props {
  storage: ReceiverStorage;
  queued: number;
  onSend: () => void;
  onReceive: () => void;
}

export function Home({ storage, queued, onSend, onReceive }: Props) {
  const engine = storage.engine;
  const { sessions } = useEngineSnapshot(engine, 500);
  const all = sessions.flatMap((s) => s.files);
  const received = all.filter((f) => f.status === 'verified').sort((a, b) => b.lastActivity - a.lastActivity);
  const incompleteSessions = sessions.filter((s) => s.files.some((f) => f.status !== 'verified'));

  return (
    <main className="screen home">
      <header className="brand">
        <h1><span className="logo" aria-hidden="true">▣</span> OptiSend</h1>
        <p className="muted">Move files between devices using only a screen and a camera. Nothing is uploaded.</p>
      </header>

      <RestoreNotice storage={storage} />

      <div className="home-actions">
        <button type="button" className="action-card" onClick={onSend}>
          <span className="action-icon" aria-hidden="true">↑</span>
          <span className="action-title">Send files</span>
          <span className="action-sub muted">{queued ? `${pluralize(queued, 'file')} queued` : 'Turn files into a stream of QR codes'}</span>
        </button>
        <button type="button" className="action-card" onClick={onReceive}>
          <span className="action-icon" aria-hidden="true">↓</span>
          <span className="action-title">Receive transfer</span>
          <span className="action-sub muted">Scan codes with this device's camera</span>
        </button>
      </div>

      <section className="card" aria-labelledby="rx-h">
        <h2 id="rx-h">Received files</h2>
        {received.length === 0 ? <p className="muted">Nothing received yet.</p> : (
          <ul className="rx-files">
            {received.map((f) => <ReceivedRow key={`${f.sessionId}/${f.fileId}`} engine={engine} f={f} />)}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="inc-h">
        <h2 id="inc-h">Incomplete transfers</h2>
        {incompleteSessions.length === 0 ? <p className="muted">None.</p> : (
          <ul className="rx-files">
            {incompleteSessions.map((s) => <IncompleteRow key={s.sessionId} engine={engine} s={s} onResume={onReceive} />)}
          </ul>
        )}
      </section>

      <StoragePanel storage={storage} sessions={sessions} />
    </main>
  );
}

function RestoreNotice({ storage }: { storage: ReceiverStorage }) {
  const [dismissed, setDismissed] = useState(false);
  const r = storage.restoreReport;
  if (!storage.state.durable) {
    return (
      <p className="notice notice-warn" role="status">
        Browser storage is unavailable here{storage.state.reason ? ` (${storage.state.reason})` : ''}. Received files are kept only while this page stays open — save them before leaving.
      </p>
    );
  }
  if (dismissed || !r || (r.sessions === 0 && r.discarded === 0)) return null;
  const parts = [`Restored ${pluralize(r.files, 'file')} from your last visit.`];
  if (r.lostChunks > 0) parts.push(`The browser had cleared ${pluralize(r.lostChunks, 'saved chunk')}; ${r.lostChunks === 1 ? 'it' : 'they'} will be received again.`);
  if (r.recoveredChunks > 0) parts.push(`Recovered ${pluralize(r.recoveredChunks, 'chunk')} saved just before the page closed.`);
  if (r.discarded > 0) parts.push(`${pluralize(r.discarded, 'damaged record')} could not be restored.`);
  return (
    <div className="notice" role="status">
      <p>{parts.join(' ')}</p>
      <button type="button" className="btn btn-ghost" onClick={() => setDismissed(true)}>Dismiss</button>
    </div>
  );
}

function ReceivedRow({ engine, f }: { engine: ReceiverEngine; f: FileSnapshot }) {
  return (
    <li className="rx-file">
      <div className="row-between">
        <span className="file-name" title={f.displayName}>{f.displayName}</span>
        <span className="badge badge-verified">✓ Verified</span>
      </div>
      <p className="muted small">
        {formatBytes(f.fileSize)}{f.mimeType ? ` · ${f.mimeType}` : ''} · received {formatWhen(f.timing.verifiedAt ?? f.lastActivity)} · SHA-256 checked
      </p>
      <TransferSpeed f={f} />
      <FileActions engine={engine} f={f} allowDelete />
    </li>
  );
}

function IncompleteRow({ engine, s, onResume }: { engine: ReceiverEngine; s: SessionSnapshot; onResume: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const pending = s.files.filter((f) => f.status !== 'verified');
  const pct = Math.floor(s.progress * 100);
  return (
    <li className="rx-file">
      <div className="row-between">
        <span className="file-name">{pending.length === 1 ? pending[0]!.displayName : `${pluralize(pending.length, 'file')} in progress`}</span>
        <span className="muted small">{pct}%</span>
      </div>
      <p className="muted small">
        {formatBytes(s.storedBytes)} of {formatBytes(s.totalBytes)} · {pluralize(pending.reduce((n, f) => n + f.missingChunks, 0), 'chunk')} missing
        {pending.some((f) => f.status === 'hash-mismatch') ? ' · a file failed verification' : ''} · last activity {formatWhen(s.lastActivity)}
      </p>
      {confirming ? (
        <div className="confirm-row" role="group" aria-label="Confirm deleting this transfer">
          <span className="small">Delete this transfer and its {formatBytes(s.storedBytes)} of saved data?</span>
          <div className="button-row">
            <button type="button" className="btn btn-destructive" onClick={() => void engine.removeSession(s.sessionId)}>Delete transfer</button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="button-row">
          <button type="button" className="btn" onClick={onResume}>Resume receiving</button>
          <button type="button" className="btn btn-ghost btn-danger-text" onClick={() => setConfirming(true)}>Delete</button>
        </div>
      )}
    </li>
  );
}

function StoragePanel({ storage, sessions }: { storage: ReceiverStorage; sessions: SessionSnapshot[] }) {
  const [est, setEst] = useState<StorageEstimateInfo | null>(null);
  const [ours, setOurs] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const signature = sessions.map((s) => `${s.sessionId}:${s.storedBytes}:${s.files.length}`).join('|');

  useEffect(() => {
    let live = true;
    void ReceiverStorage.estimate().then((e) => live && setEst(e));
    void storage.usageBySession().then((m) => live && setOurs([...m.values()].reduce((a, b) => a + b, 0)));
    return () => { live = false; };
  }, [storage, signature]);

  const completeBytes = sessions.flatMap((s) => s.files).filter((f) => f.status === 'verified').reduce((n, f) => n + f.fileSize, 0);
  const incompleteBytes = sessions.flatMap((s) => s.files).filter((f) => f.status !== 'verified').reduce((n, f) => n + f.storedBytes, 0);
  const fileCount = sessions.reduce((n, s) => n + s.files.length, 0);

  const persist = async () => {
    const ok = await ReceiverStorage.requestPersistence();
    setMessage(ok ? 'This browser will keep OptiSend’s files unless you clear them.' : 'The browser did not grant persistent storage. Save important files outside the app.');
    setEst(await ReceiverStorage.estimate());
  };

  const clearAll = async () => {
    await storage.clearAll();
    setConfirmClear(false);
    setMessage('All received and incomplete transfers were deleted.');
  };

  return (
    <section className="card" aria-labelledby="st-h">
      <h2 id="st-h">Storage on this device</h2>
      <dl className="stats">
        <div><dt>Received files</dt><dd>{formatBytes(completeBytes)}</dd></div>
        <div><dt>Incomplete transfers</dt><dd>{formatBytes(incompleteBytes)}</dd></div>
        <div><dt>OptiSend total</dt><dd>{ours === null ? '—' : formatBytes(ours)}</dd></div>
        {est?.quota != null && <div><dt>Browser quota left</dt><dd>{formatBytes(Math.max(0, est.quota - (est.usage ?? 0)))}</dd></div>}
      </dl>
      {storage.state.saveFailures > 0 && (
        <p className="error-text small" role="alert">{pluralize(storage.state.saveFailures, 'save')} failed{storage.state.lastSaveError ? `: ${storage.state.lastSaveError}` : ''}. Progress since then may not survive a reload.</p>
      )}
      <p className="muted small">
        Browsers can clear website storage when space runs low{est?.persisted ? ', but this browser has granted OptiSend persistent storage' : ''}. Save important files somewhere permanent.
      </p>
      <div className="button-row">
        {storage.state.durable && est?.persisted === false && <button type="button" className="btn" onClick={() => void persist()}>Keep files on this device</button>}
        {fileCount > 0 && !confirmClear && <button type="button" className="btn btn-ghost btn-danger-text" onClick={() => setConfirmClear(true)}>Clear all data…</button>}
      </div>
      {confirmClear && (
        <div className="confirm-row" role="group" aria-label="Confirm clearing all data">
          <span className="small">Delete all {pluralize(fileCount, 'file')} ({formatBytes(completeBytes + incompleteBytes)}), including incomplete transfers? This cannot be undone.</span>
          <div className="button-row">
            <button type="button" className="btn btn-destructive" onClick={() => void clearAll()}>Delete everything</button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmClear(false)}>Cancel</button>
          </div>
        </div>
      )}
      {message && <p className="small" role="status">{message}</p>}
    </section>
  );
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
