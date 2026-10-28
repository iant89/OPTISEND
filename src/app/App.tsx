import { useEffect, useState } from 'react';
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
      return <Home queued={queue.length} onSend={() => setScreen({ name: 'send' })} onReceive={() => setScreen({ name: 'receive' })} />;
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
      return <ReceivePlaceholder onBack={() => setScreen({ name: 'home' })} />;
  }
}

function Home({ queued, onSend, onReceive }: { queued: number; onSend: () => void; onReceive: () => void }) {
  const [storage, setStorage] = useState<string | null>(null);
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
      <section className="card">
        <h2>Received files</h2>
        <p className="muted">Nothing received yet.</p>
      </section>
      <section className="card">
        <h2>Incomplete transfers</h2>
        <p className="muted">None.</p>
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

function ReceivePlaceholder({ onBack }: { onBack: () => void }) {
  return (
    <main className="screen">
      <header className="screen-header">
        <button type="button" className="btn btn-ghost" onClick={onBack} aria-label="Back to home">← Back</button>
        <h1>Receive transfer</h1>
      </header>
      <section className="card">
        <p>The camera receiver is coming in the next build (Phase 3).</p>
      </section>
    </main>
  );
}
