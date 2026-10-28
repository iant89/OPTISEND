import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { PacketRef, TransferPlan } from '../../protocol/sender.ts';
import type { QrMatrix } from '../../qr/encoder.ts';
import { QrCanvas } from '../../components/QrCanvas.tsx';
import { SegmentedBar, SEG_CURRENT, SEG_EMPTY, SEG_FILLED } from '../../components/SegmentedBar.tsx';
import { useWakeLock } from '../../hooks/useWakeLock.ts';
import { QrEncoderClient } from '../../workers/clients.ts';
import { formatDuration } from '../../utils/format.ts';
import { FrameRenderer } from './frames.ts';
import { TransmissionScheduler, type FrameEvent, type SchedulerState, type SchedulerStats } from './scheduler.ts';
import { INTERVAL_CHOICES, type ResolvedQrConfig, type SenderSettings } from './settings.ts';

export interface TransmissionSummary {
  outcome: 'stopped' | 'finished';
  stats: SchedulerStats;
  framesPerPass: number;
  fileCount: number;
  totalBytes: number;
  lateFrames: number;
}

interface Props {
  plan: TransferPlan;
  cfg: ResolvedQrConfig;
  settings: SenderSettings;
  onExit: (summary: TransmissionSummary) => void;
}

const PREFETCH = 3;

export function TransmitView({ plan, cfg, settings, onExit }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frames = useMemo<PacketRef[]>(() => [...plan.pass({ strategy: settings.strategy, manifestEvery: settings.manifestEvery })], [plan, settings.strategy, settings.manifestEvery]);
  const scheduler = useMemo(
    () => new TransmissionScheduler<PacketRef>({
      frames,
      intervalMs: settings.intervalMs,
      passes: settings.passes,
      holdFactor: (f) => (settings.holdManifest && f.kind === 'manifest' ? 2 : 1),
    }),
    [frames],
  );
  const encoder = useMemo(() => new QrEncoderClient(), []);
  const renderer = useMemo(() => new FrameRenderer(plan, cfg, encoder), [plan, cfg, encoder]);

  const [matrix, setMatrix] = useState<QrMatrix | null>(null);
  const [frame, setFrame] = useState<FrameEvent<PacketRef> | null>(null);
  const [state, setState] = useState<SchedulerState>('idle');
  const [interval, setIntervalMs] = useState(settings.intervalMs);
  const [announce, setAnnounce] = useState('');
  const [hiddenPause, setHiddenPause] = useState(false);
  const [allBroadcast, setAllBroadcast] = useState(false);
  const lateFrames = useRef(0);
  const drawToken = useRef(0);

  // Per-pass broadcast map for the segmented bar.
  const seg = useMemo(() => new Uint8Array(frames.length), [frames]);
  const [segVersion, setSegVersion] = useState(0);
  const segPass = useRef(1);
  const segFilled = useRef(0);

  useWakeLock(state === 'running' || state === 'paused');

  // ── Scheduler wiring ──
  useEffect(() => {
    const offFrame = scheduler.onFrame((e) => {
      setFrame(e);
      if (scheduler.stats.allBroadcast) setAllBroadcast(true);
      if (e.pass !== segPass.current) {
        seg.fill(SEG_EMPTY);
        segPass.current = e.pass;
        segFilled.current = 0;
      }
      for (let i = 0; i < seg.length; i++) if (seg[i] === SEG_CURRENT) seg[i] = SEG_FILLED;
      if (seg[e.index] === SEG_EMPTY) segFilled.current++;
      seg[e.index] = SEG_CURRENT;
      setSegVersion((v) => v + 1);

      const token = ++drawToken.current;
      const ready = renderer.has(e.frame, e.pass);
      const t0 = performance.now();
      renderer.get(e.frame, e.pass).then((m) => {
        if (token !== drawToken.current) return; // a newer frame superseded this one
        if (!ready && performance.now() - t0 > 50) lateFrames.current++;
        setMatrix(m);
      }, () => { lateFrames.current++; });
      renderer.prefetch(scheduler.peekWithPass(PREFETCH));
    });
    const offState = scheduler.onState((s) => {
      setState(s);
      if (s === 'paused') setAnnounce('Transmission paused');
      else if (s === 'running') setAnnounce('Transmitting');
      else if (s === 'finished') setAnnounce('All passes broadcast');
      else if (s === 'stopped') setAnnounce('Transmission stopped');
    });
    renderer.prefetch(frames.slice(0, PREFETCH + 1).map((frame) => ({ frame, pass: 1 })));
    // Give the first frame a moment to render before the clock starts.
    void renderer.get(frames[0]!).finally(() => scheduler.start());
    return () => {
      offFrame();
      offState();
      scheduler.dispose();
    };
  }, [scheduler, renderer]);

  useEffect(() => () => encoder.dispose(), [encoder]);

  // ── Full screen (where supported; iPhone Safari falls back to the fixed viewport layout) ──
  useEffect(() => {
    const el = rootRef.current;
    if (el && document.fullscreenEnabled && !document.fullscreenElement) void el.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => undefined);
    return () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); };
  }, []);

  // ── A hidden page shows no QR code: pause, and tell the user why ──
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden' && scheduler.state === 'running') {
        scheduler.pause();
        setHiddenPause(true);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [scheduler]);

  const exit = (outcome: 'stopped' | 'finished') => {
    scheduler.stop();
    onExit({ outcome, stats: scheduler.stats, framesPerPass: frames.length, fileCount: plan.files.length, totalBytes: plan.totalBytes, lateFrames: lateFrames.current });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLSelectElement) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); scheduler.next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); scheduler.prev(); }
  };
  const toggle = () => {
    setHiddenPause(false);
    scheduler.togglePause();
  };
  const changeInterval = (ms: number) => {
    scheduler.setIntervalMs(ms);
    setIntervalMs(ms);
  };

  // ── Frame description ──
  const ref = frame?.frame;
  const file = ref?.kind === 'data' ? plan.files[ref.fileId] : undefined;
  const passLabel = settings.passes === 'continuous' ? `Pass ${frame?.pass ?? 1}` : `Pass ${frame?.pass ?? 1} of ${scheduler.passes}`;
  const remainingMs = scheduler.passDurationMs() * ((frames.length - 1 - (frame?.index ?? 0)) / frames.length);
  const qrLabel = !ref ? 'Preparing first QR code'
    : ref.kind === 'manifest' ? `QR code: file list, part ${ref.part + 1} of ${plan.manifestPackets.length}`
    : `QR code: ${file?.name}, chunk ${ref.chunkIndex + 1} of ${file?.chunkCount}`;

  return (
    <div ref={rootRef} className={`transmit state-${state}`} tabIndex={-1} onKeyDown={onKey} role="region" aria-label="Transmitting files">
      <div className="transmit-qr">
        <QrCanvas matrix={matrix} label={qrLabel} />
        {state === 'paused' && <div className="paused-badge" aria-hidden="true">Paused</div>}
      </div>

      <div className="transmit-panel">
        <div className="frame-info">
          {ref?.kind === 'data' && file ? (
            <>
              <p className="frame-file" title={file.name}>{file.name}</p>
              <p className="muted">
                File {ref.fileId + 1} of {plan.files.length} · chunk {(ref.chunkIndex + 1).toLocaleString()} of {file.chunkCount.toLocaleString()}
              </p>
            </>
          ) : (
            <>
              <p className="frame-file">File list</p>
              <p className="muted">{plan.files.length} {plan.files.length === 1 ? 'file' : 'files'}{ref?.kind === 'manifest' && plan.manifestPackets.length > 1 ? ` · part ${ref.part + 1} of ${plan.manifestPackets.length}` : ''}</p>
            </>
          )}
          <p className="muted">
            {passLabel} · code {((frame?.index ?? 0) + 1).toLocaleString()} of {frames.length.toLocaleString()} · ~{formatDuration(remainingMs)} left in pass
          </p>
        </div>

        <SegmentedBar
          states={seg}
          version={segVersion}
          label="Codes broadcast in this pass"
          filled={segFilled.current}
          valueText={`${segFilled.current} of ${frames.length} codes broadcast in ${passLabel.toLowerCase()}`}
        />

        <p className={`transmit-status ${state}`}>
          {state === 'running' && (settings.passes === 'continuous' ? '● Transmitting — loops until you stop' : '● Transmitting')}
          {state === 'paused' && (hiddenPause ? '❚❚ Paused because the page was hidden' : '❚❚ Paused')}
          {state === 'finished' && '✓ All passes broadcast — check the receiving device'}
          {state === 'idle' && 'Starting…'}
        </p>

        <div className="transmit-controls" role="group" aria-label="Transmission controls">
          <button type="button" className="btn btn-icon-lg" onClick={() => scheduler.prev()} aria-label="Previous code" disabled={state === 'idle'}>⏮</button>
          {state === 'finished' ? (
            <button type="button" className="btn btn-primary btn-wide" onClick={() => scheduler.repeatPass()}>Repeat pass</button>
          ) : (
            <button type="button" className="btn btn-primary btn-wide" onClick={toggle} disabled={state === 'idle'} aria-keyshortcuts="Space">
              {state === 'paused' ? 'Resume' : 'Pause'}
            </button>
          )}
          <button type="button" className="btn btn-icon-lg" onClick={() => scheduler.next()} aria-label="Next code" disabled={state === 'idle'}>⏭</button>
        </div>

        <div className="transmit-secondary">
          <label className="inline-field">
            <span className="muted">Each code</span>
            <select value={interval} onChange={(e: ChangeEvent<HTMLSelectElement>) => changeInterval(Number(e.currentTarget.value))} aria-label="Time each code is shown">
              {Array.from(new Set([...INTERVAL_CHOICES, interval])).sort((a, b) => a - b).map((ms) => (
                <option key={ms} value={ms}>{ms < 1000 ? `${ms} ms` : `${ms / 1000} s`}</option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          {state !== 'finished' && <button type="button" className="btn btn-danger" onClick={() => exit('stopped')}>Stop</button>}
          {allBroadcast && <button type="button" className="btn" onClick={() => exit('finished')}>Finish</button>}
        </div>
      </div>
      <div className="visually-hidden" aria-live="polite">{announce}</div>
    </div>
  );
}
