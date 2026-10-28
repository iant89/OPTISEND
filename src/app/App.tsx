import { useEffect, useState } from 'react';
import { ReceiveScreen, type ReceiverPrefs } from '../features/receiver/ReceiveScreen.tsx';
import { DECODER_MODES } from '../features/receiver/decoders.ts';
import { ReceiverStorage } from '../storage/persistence.ts';
import { Home } from './Home.tsx';
import type { TransferPlan } from '../protocol/sender.ts';
import { SendScreen, type QueuedFile } from '../features/sender/SendScreen.tsx';
import { TransmitView, type TransmissionSummary } from '../features/sender/TransmitView.tsx';
import { DEFAULT_SETTINGS, migrateLegacySettings, sanitizeSettings, type ResolvedQrConfig, type SenderSettings } from '../features/sender/settings.ts';
import { formatBytes, formatDuration } from '../utils/format.ts';

type Screen =
  | { name: 'home' }
  | { name: 'send' }
  | { name: 'transmit'; plan: TransferPlan; cfg: ResolvedQrConfig; runId: number }
  | { name: 'summary'; summary: TransmissionSummary; plan: TransferPlan; cfg: ResolvedQrConfig }
  | { name: 'receive' };

const SETTINGS_KEY = 'optisend.sender.settings.v3';
/** v1 saved every field, including the old 750 ms default, even if the user never chose it. */
/** Older settings, newest first: migrated once, then saved under SETTINGS_KEY. */
const LEGACY_SETTINGS_KEYS = ['optisend.sender.settings.v2', 'optisend.sender.settings.v1'];
const RX_PREFS_KEY = 'optisend.receiver.prefs.v1';

function loadRxPrefs(): ReceiverPrefs {
  const d: ReceiverPrefs = { decoderMode: 'auto', vibrate: false };
  try {
    const r = JSON.parse(localStorage.getItem(RX_PREFS_KEY) ?? 'null') as Partial<ReceiverPrefs> | null;
    return {
      decoderMode: r?.decoderMode && DECODER_MODES.includes(r.decoderMode) ? r.decoderMode : d.decoderMode,
      vibrate: typeof r?.vibrate === 'boolean' ? r.vibrate : d.vibrate,
    };
  } catch {
    return d;
  }
}

function loadSettings(): SenderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw));
    for (const key of LEGACY_SETTINGS_KEYS) {
      const legacy = localStorage.getItem(key);
      if (legacy) return migrateLegacySettings(JSON.parse(legacy));
    }
    return { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [settings, setSettings] = useState<SenderSettings>(loadSettings);
  const [rxPrefs, setRxPrefs] = useState<ReceiverPrefs>(loadRxPrefs);
  // One receiver engine for the app's lifetime, backed by IndexedDB: transfers
  // survive leaving the receive screen and reloading the page.
  const [storage, setStorage] = useState<ReceiverStorage | null>(null);
  useEffect(() => {
    let live = true;
    void ReceiverStorage.open().then((s) => { if (live) setStorage(s); else s.dispose(); });
    return () => { live = false; };
  }, []);

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

  if (!storage && (screen.name === 'home' || screen.name === 'receive')) {
    return (
      <main className="screen"><p className="muted" role="status">Loading saved transfers…</p></main>
    );
  }

  switch (screen.name) {
    case 'home':
      return <Home storage={storage!} queued={queue.length} onSend={() => setScreen({ name: 'send' })} onReceive={() => setScreen({ name: 'receive' })} />;
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
      return <ReceiveScreen storage={storage!} prefs={rxPrefs} setPrefs={setRxPrefs} onExit={() => { void storage!.flush(); setScreen({ name: 'home' }); }} />;
  }
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
