import { useEffect, useMemo, useState } from 'react';
import { ReceiverEngine, type FileSnapshot } from '../protocol/receiver.ts';
import { MemoryChunkStore } from '../protocol/chunk-store.ts';
import { ReceiveScreen, type ReceiverPrefs } from '../features/receiver/ReceiveScreen.tsx';
import { FileActions } from '../features/files/FileActions.tsx';
import { useEngineSnapshot } from '../hooks/useEngineSnapshot.ts';
import type { TransferPlan } from '../protocol/sender.ts';
import { SendScreen, type QueuedFile } from '../features/sender/SendScreen.tsx';
import { TransmitView, type TransmissionSummary } from '../features/sender/TransmitView.tsx';
import { DEFAULT_SETTINGS, sanitizeSettings, type ResolvedQrConfig, type SenderSettings } from '../features/sender/settings.ts';
import { formatBytes, formatDuration, pluralize } from '../utils/format.ts';

type Screen =
  | { name: 'home' }
  | { name: 'send' }
  | { name: 'transmit'; plan: TransferPlan; cfg: ResolvedQrConfig; runId: number }
  | { name: 'summary'; summary: TransmissionSummary; plan: TransferPlan; cfg: ResolvedQrConfig }
  | { name: 'receive' };

const SETTINGS_KEY = 'optisend.sender.settings.v1';
const RX_PREFS_KEY = 'optisend.receiver.prefs.v1';

function loadRxPrefs(): ReceiverPrefs {
  const d: ReceiverPrefs = { decoderMode: 'auto', vibrate: false };
  try {
    const r = JSON.parse(localStorage.getItem(RX_PREFS_KEY) ?? 'null') as Partial<ReceiverPrefs> | null;
    return {
      decoderMode: r?.decoderMode && ['auto', 'jsqr', 'native', 'compare'].includes(r.decoderMode) ? r.decoderMode : d.decoderMode,
      vibrate: typeof r?.vibrate === 'boolean' ? r.vibrate : d.vibrate,
    };
  } catch {
    return d;
  }
}

function loadSettings(): SenderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [settings, setSettings] = useState<SenderSettings>(loadSettings);
  const [rxPrefs, setRxPrefs] = useState<ReceiverPrefs>(loadRxPrefs);
  // One receiver engine for the app's lifetime: leaving the receive screen keeps
  // partial transfers, so the user can resume (persistence arrives in Phase 4).
  const engine = useMemo(() => new ReceiverEngine({ store: new MemoryChunkStore() }), []);

  useEffect(() => {
    try { localStorage.setItem(RX_PREFS_KEY, JSON.stringify(rxPrefs)); } catch { /* per-visit only */ }
  }, [rxPrefs]);

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable: settings are per-visit */ }
  }, [settings]);

  // Move focus to the new screen's heading for keyboard and screen-reader users.
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('.transmit, main h1');
    if (el) { if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); }
  }, [screen.name]);

  switch (screen.name) {
    case 'home':
      return <Home engine={engine} queued={queue.length} onSend={() => setScreen({ name: 'send' })} onReceive={() => setScreen({ name: 'receive' })} />;
    case 'send':
      return (
        <SendScreen
          queue={queue}
          setQueue={setQueue}
          settings={settings}
          setSettings={setSettings}
          onBack={() => setScreen({ name: 'home' })}
          onStart={(plan, cfg) => setScreen({ name: 'transmit', plan, cfg, runId: Date.now() })}
        />
      );
    case 'transmit':
      return <TransmitView key={screen.runId} plan={screen.plan} cfg={screen.cfg} settings={settings} onExit={(summary) => setScreen({ name: 'summary', summary, plan: screen.plan, cfg: screen.cfg })} />;
    case 'summary':
      return (
        <Summary
          s={screen.summary}
          onRestart={() => setScreen({ name: 'transmit', plan: screen.plan, cfg: screen.cfg, runId: Date.now() })}
          onBack={() => setScreen({ name: 'send' })}
          onDone={() => { setQueue([]); setScreen({ name: 'home' }); }}
        />
      );
    case 'receive':
      return <ReceiveScreen engine={engine} prefs={rxPrefs} setPrefs={setRxPrefs} onExit={() => setScreen({ name: 'home' })} />;
  }
}

function Home({ engine, queued, onSend, onReceive }: { engine: ReceiverEngine; queued: number; onSend: () => void; onReceive: () => void }) {
  const [storage, setStorage] = useState<string | null>(null);
  const { sessions } = useEngineSnapshot(engine, 500);
  const all = sessions.flatMap((s) => s.files);
  const received = all.filter((f) => f.status === 'verified');
  const incomplete = all.filter((f) => f.status !== 'verified');
  useEffect(() => {
    navigator.storage?.estimate?.().then(
      (e) => { if (e.quota) setStorage(`${formatBytes(e.usage ?? 0)} used of ${formatBytes(e.quota)} available`); },
      () => undefined,
    );
  }, []);
  return (
    <main className="screen home">
      <header className="brand">
        <h1><span className="logo" aria-hidden="true">▣</span> OptiSend</h1>
        <p className="muted">Move files between devices using only a screen and a camera. Nothing is uploaded.</p>
      </header>
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
        {received.length > 0 && <p className="muted small">Received files are kept only while this page is open. Save the ones you need.</p>}
      </section>
      <section className="card" aria-labelledby="inc-h">
        <h2 id="inc-h">Incomplete transfers</h2>
        {incomplete.length === 0 ? <p className="muted">None.</p> : (
          <>
            <ul className="rx-files">
              {incomplete.map((f) => (
                <li key={`${f.sessionId}/${f.fileId}`} className="rx-file">
                  <div className="row-between">
                    <span className="file-name">{f.displayName}</span>
                    <span className="muted small">{Math.floor(f.progress * 100)}% · {f.missingChunks.toLocaleString()} chunks missing</span>
                  </div>
                </li>
              ))}
            </ul>
            <button type="button" className="btn" onClick={onReceive}>Resume receiving</button>
          </>
        )}
      </section>
      {storage && <p className="muted small center">Browser storage: {storage}</p>}
    </main>
  );
}

function Summary({ s, onRestart, onBack, onDone }: { s: TransmissionSummary; onRestart: () => void; onBack: () => void; onDone: () => void }) {
  return (
    <main className="screen summary">
      <header className="screen-header">
        <h1>{s.outcome === 'finished' ? 'Broadcast finished' : 'Transmission stopped'}</h1>
      </header>
      <section className="card">
        <dl className="stats">
          <div><dt>Files</dt><dd>{s.fileCount} · {formatBytes(s.totalBytes)}</dd></div>
          <div><dt>Codes shown</dt><dd>{s.stats.framesShown.toLocaleString()}</dd></div>
          <div><dt>Complete passes</dt><dd>{s.stats.passesCompleted}</dd></div>
          <div><dt>Every code shown</dt><dd>{s.stats.allBroadcast ? 'Yes' : 'Not yet'}</dd></div>
          <div><dt>Time transmitting</dt><dd>{formatDuration(s.stats.activeMs)}</dd></div>
          <div><dt>Codes per pass</dt><dd>{s.framesPerPass.toLocaleString()}</dd></div>
        </dl>
        {(s.lateFrames > 0 || s.stats.lateResyncs > 0) && (
          <p className="muted small">Timing: {s.lateFrames} codes rendered late, {s.stats.lateResyncs} timer resyncs. A slower interval may help on this device.</p>
        )}
      </section>
      <p className="notice" role="note">
        This device only knows what it displayed, not what was captured. Check the receiving device: a file is complete only when it shows as verified there.
      </p>
      <div className="button-row">
        <button type="button" className="btn btn-primary" onClick={onRestart}>Transmit again</button>
        <button type="button" className="btn" onClick={onBack}>Change files or settings</button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>Done</button>
      </div>
    </main>
  );
}

function ReceivedRow({ engine, f }: { engine: ReceiverEngine; f: FileSnapshot }) {
  return (
    <li className="rx-file">
      <div className="row-between">
        <span className="file-name" title={f.displayName}>{f.displayName}</span>
        <span className="badge badge-verified">✓ Verified</span>
      </div>
      <p className="muted small">{formatBytes(f.fileSize)}{f.mimeType ? ` · ${f.mimeType}` : ''} · received {new Date(f.lastActivity).toLocaleTimeString()}</p>
      <FileActions engine={engine} f={f} />
    </li>
  );
}
