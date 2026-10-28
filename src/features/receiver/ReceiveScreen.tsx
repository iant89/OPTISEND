import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { FileSnapshot, ReceiverEngine, SessionSnapshot } from '../../protocol/receiver.ts';
import type { DecoderStats } from '../../qr/decoders/chain.ts';
import { SegmentedBar } from '../../components/SegmentedBar.tsx';
import { CameraError, classifyCameraError, describeCameraError, openCamera, stopStream, type CameraErrorKind } from '../../camera/camera.ts';
import { useEngineSnapshot } from '../../hooks/useEngineSnapshot.ts';
import { useWakeLock } from '../../hooks/useWakeLock.ts';
import { formatBytes, pluralize } from '../../utils/format.ts';
import { buildDecoderChain, DECODER_MODE_LABELS, type DecoderMode } from './decoders.ts';
import { regionOnElement } from './region.ts';
import { FrameScanner, type ScannerStats } from './scanner.ts';
import { bitmapToSegments } from './segments.ts';
import { FileActions } from '../files/FileActions.tsx';
import { TransferSpeed } from '../files/TransferSpeed.tsx';
import { ReceiverStorage } from '../../storage/persistence.ts';

export interface ReceiverPrefs {
  decoderMode: DecoderMode;
  vibrate: boolean;
}

interface Props {
  storage: ReceiverStorage;
  prefs: ReceiverPrefs;
  setPrefs: (p: ReceiverPrefs) => void;
  onExit: () => void;
}

type CamState = { kind: 'starting' } | { kind: 'live' } | { kind: 'error'; error: CameraErrorKind; detail: string };

export function ReceiveScreen({ storage, prefs, setPrefs, onExit }: Props) {
  const engine = storage.engine;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scannerRef = useRef<FrameScanner | null>(null);
  const [cam, setCam] = useState<CamState>({ kind: 'starting' });
  const [paused, setPaused] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [scanStats, setScanStats] = useState<ScannerStats | null>(null);
  const [decoderStats, setDecoderStats] = useState<DecoderStats[]>([]);
  const [guide, setGuide] = useState<{ left: number; top: number; size: number } | null>(null);
  const [flash, setFlash] = useState(0);
  const [announce, setAnnounce] = useState('');
  const { sessions } = useEngineSnapshot(engine);
  const [storageIssue, setStorageIssue] = useState<{ quota: boolean; detail: string; count: number } | null>(null);
  const [available, setAvailable] = useState<number | null>(null);

  useWakeLock(cam.kind === 'live' && !paused);

  // ── Camera + scanner lifecycle ──
  useEffect(() => {
    let stream: MediaStream | null = null;
    let disposed = false;
    let chainDispose: (() => void) | null = null;
    setCam({ kind: 'starting' });
    (async () => {
      try {
        stream = await openCamera();
        if (disposed) { stopStream(stream); return; }
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        const { chain } = await buildDecoderChain(prefs.decoderMode);
        const zxingFirst = chain.ids[0] === 'zxing';
        if (disposed) { chain.dispose(); return; }
        chainDispose = () => chain.dispose();
        const scanner = new FrameScanner(video, chain, (packet) => { void engine.ingest(packet); }, { alternateGuide: !zxingFirst });
        scannerRef.current = scanner;
        scanner.start();
        setCam({ kind: 'live' });
        const statTimer = setInterval(() => {
          setScanStats({ ...scanner.stats });
          setDecoderStats(chain.snapshotStats());
          const v = videoRef.current;
          const stage = stageRef.current;
          if (v && stage && scanner.region && v.videoWidth) setGuide(regionOnElement(v.videoWidth, v.videoHeight, stage.clientWidth, stage.clientHeight, scanner.region));
        }, 500);
        chainDispose = () => { clearInterval(statTimer); chain.dispose(); };
      } catch (e) {
        if (disposed) return;
        const err = e instanceof CameraError ? e : classifyCameraError(e);
        setCam({ kind: 'error', error: err.kind, detail: err.message });
      }
    })();
    return () => {
      disposed = true;
      scannerRef.current?.stop();
      scannerRef.current = null;
      chainDispose?.();
      stopStream(stream);
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [engine, prefs.decoderMode, attempt]);

  // Scan only while not paused and the page is visible (the camera keeps running so resume is instant).
  useEffect(() => {
    // Per-file transfer clocks run only while we are actually scanning.
    const apply = () => {
      const s = scannerRef.current;
      const scanning = !!s && cam.kind === 'live' && !paused && document.visibilityState !== 'hidden';
      engine.setReceiving(scanning);
      if (!s) return;
      if (scanning) s.start();
      else s.stop();
    };
    apply();
    document.addEventListener('visibilitychange', apply);
    return () => {
      document.removeEventListener('visibilitychange', apply);
      engine.setReceiving(false);
    };
  }, [paused, cam.kind, engine]);

  // ── Feedback: subtle flash for new chunks, announcement + optional vibration for completed files ──
  useEffect(() => engine.subscribe((r) => {
    if (r.status === 'accepted') {
      setFlash((n) => n + 1);
      if (r.fileStatus === 'verified') {
        const f = engine.snapshot().find((s) => s.sessionId === r.sessionId)?.files.find((x) => x.fileId === r.fileId);
        setAnnounce(`${f?.displayName ?? 'File'} received and verified`);
        if (prefs.vibrate) navigator.vibrate?.([60, 40, 60]);
      } else if (r.fileStatus === 'hash-mismatch') {
        setAnnounce('A file failed verification');
      }
    } else if (r.status === 'manifest') {
      setAnnounce(`Transfer found: ${pluralize(r.newFiles, 'new file')}`);
    }
  }), [engine, prefs.vibrate]);

  // Storage problems (spec §9.4, §11.3): failed writes are not counted and stay eligible for the next pass.
  useEffect(() => engine.subscribe((r) => {
    if (r.status !== 'storage-error') return;
    const quota = /full|quota/i.test(r.detail);
    setStorageIssue((prev) => ({ quota, detail: r.detail, count: (prev?.count ?? 0) + 1 }));
    if (quota) setAnnounce('Storage is full: some data could not be saved');
  }), [engine]);
  useEffect(() => {
    void ReceiverStorage.estimate().then((e) => setAvailable(e.quota != null ? Math.max(0, e.quota - (e.usage ?? 0)) : null));
  }, [storageIssue?.count]);

  const active = pickActiveSession(sessions);
  // Pre-flight: does the rest of this transfer fit in the browser's storage quota?
  const remaining = active ? active.totalBytes - active.storedBytes : 0;
  const tooBig = active !== null && active.allFilesKnown && available !== null && remaining > available;
  const st = engine.stats;
  const files = active?.files ?? [];
  const missing = files.reduce((n, f) => n + f.missingChunks, 0);
  const valid = files.reduce((n, f) => n + f.receivedChunks, 0);

  const statusText = cam.kind === 'starting' ? 'Starting camera…'
    : cam.kind === 'error' ? describeCameraError(cam.error).title
    : paused ? 'Scanning paused'
    : !active ? 'Point the camera at the sender’s screen'
    : active.complete ? 'All files received and verified'
    : 'Receiving…';

  return (
    <div className="receive" role="region" aria-label="Receiving files">
      <div ref={stageRef} className="receive-stage">
        <video ref={videoRef} className="receive-video" playsInline muted autoPlay aria-label="Camera preview" />
        {cam.kind === 'live' && guide && (
          <div key={flash} className={`scan-guide ${flash ? 'pulse' : ''}`} style={{ left: `${guide.left}px`, top: `${guide.top}px`, width: `${guide.size}px`, height: `${guide.size}px` }} aria-hidden="true" />
        )}
        {cam.kind === 'error' && (
          <div className="camera-error" role="alert">
            <p className="camera-error-title">{describeCameraError(cam.error).title}</p>
            <p>{describeCameraError(cam.error).help}</p>
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
          </div>
        )}
        <p className="receive-status" role="status">{statusText}</p>
      </div>

      <div className="receive-panel">
        {!storage.state.durable && (
          <p className="notice notice-warn small" role="status">Browser storage is unavailable, so received data is kept only while this page stays open.</p>
        )}
        {storageIssue && (
          <div className="notice notice-error" role="alert">
            {storageIssue.quota ? (
              <p><strong>Storage is full.</strong> {pluralize(storageIssue.count, 'chunk')} couldn’t be saved; they will be picked up again on a later pass once space is free. Delete old transfers on the home screen, or free up space on this device.</p>
            ) : (
              <p><strong>Couldn’t save to browser storage</strong> ({storageIssue.detail}). {pluralize(storageIssue.count, 'chunk')} will be received again on a later pass.</p>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => setStorageIssue(null)}>Dismiss</button>
          </div>
        )}
        {tooBig && !storageIssue && (
          <p className="notice notice-warn small" role="status">
            This transfer needs about {formatBytes(remaining)} more, but only about {formatBytes(available ?? 0)} of browser storage is available. Free some space or delete old transfers first.
          </p>
        )}
        {active ? (
          <SessionView engine={engine} session={active} />
        ) : (
          <p className="muted">Open OptiSend on the sending device, choose files and start the transfer. Files appear here as soon as codes are read.</p>
        )}

        <dl className="stats compact">
          <div><dt>Valid chunks</dt><dd>{valid.toLocaleString()}</dd></div>
          <div><dt>Missing</dt><dd>{active ? missing.toLocaleString() : '—'}</dd></div>
          <div><dt>Duplicates</dt><dd>{st.duplicates.toLocaleString()}</dd></div>
          <div><dt>Invalid</dt><dd>{(st.rejected + st.conflicts).toLocaleString()}</dd></div>
        </dl>

        <div className="transmit-controls">
          <button type="button" className="btn btn-primary btn-wide" disabled={cam.kind !== 'live'} onClick={() => setPaused((p) => !p)}>
            {paused ? 'Resume scanning' : 'Pause scanning'}
          </button>
          <button type="button" className="btn btn-danger" onClick={onExit}>Stop receiving</button>
        </div>

        <details className="advanced">
          <summary>Scanner settings &amp; diagnostics</summary>
          <label className="field">
            <span>QR decoder</span>
            <select value={prefs.decoderMode} onChange={(e: ChangeEvent<HTMLSelectElement>) => setPrefs({ ...prefs, decoderMode: e.currentTarget.value as DecoderMode })}>
              {(Object.keys(DECODER_MODE_LABELS) as DecoderMode[]).map((m) => <option key={m} value={m}>{DECODER_MODE_LABELS[m]}</option>)}
            </select>
          </label>
          <label className="field check">
            <input type="checkbox" checked={prefs.vibrate} onChange={(e: ChangeEvent<HTMLInputElement>) => setPrefs({ ...prefs, vibrate: e.currentTarget.checked })} />
            <span>Vibrate when a file completes <span className="muted">(where supported)</span></span>
          </label>
          {scanStats && (
            <p className="muted small">
              {scanStats.fps.toFixed(1)} scans/s · {scanStats.framesScanned.toLocaleString()} frames · {scanStats.packets.toLocaleString()} packets
              {scanStats.foreign ? ` · ${scanStats.foreign} other codes ignored` : ''}{scanStats.lastVersion ? ` · QR v${scanStats.lastVersion}` : ''}
              {` · code located in ${scanStats.framesLocated.toLocaleString()} frames, ${scanStats.framesSkipped.toLocaleString()} empty frames skipped`}
              {scanStats.framesColour ? ` · ${scanStats.framesColour.toLocaleString()} colour frames` : ''}
            </p>
          )}
          {decoderStats.length > 0 && (
            <table className="diag-table">
              <thead><tr><th scope="col">Decoder</th><th scope="col">Read</th><th scope="col">Accepted</th><th scope="col">Avg ms</th></tr></thead>
              <tbody>
                {decoderStats.map((d) => (
                  <tr key={d.id}>
                    <th scope="row">{d.label}{d.binary ? '' : ' (text only)'}</th>
                    <td>{d.hits}</td>
                    <td>{d.accepted}{d.rescued ? ` (+${d.rescued})` : ''}</td>
                    <td>{d.attempts ? (d.totalMs / d.attempts).toFixed(0) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {cam.kind === 'error' && <p className="muted small">Detail: {cam.detail}</p>}
        </details>
      </div>
      <div className="visually-hidden" aria-live="polite">{announce}</div>
    </div>
  );
}

/** The session most recently active that is not yet complete, else the most recent. */
export function pickActiveSession(sessions: SessionSnapshot[]): SessionSnapshot | null {
  if (sessions.length === 0) return null;
  const sorted = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);
  return sorted.find((s) => !s.complete) ?? sorted[0]!;
}

function SessionView({ engine, session }: { engine: ReceiverEngine; session: SessionSnapshot }) {
  const pct = Math.floor(session.progress * 1000) / 10;
  return (
    <div className="session">
      <div className="row-between session-head">
        <span className="session-title">
          {session.declaredFileCount !== null ? pluralize(session.declaredFileCount, 'file') : 'Transfer'}
          {!session.allFilesKnown && <span className="muted"> · waiting for file list</span>}
        </span>
        <span className="session-pct" aria-label={`Overall ${pct}%`}>{pct}%</span>
      </div>
      <ul className="rx-files" aria-label="Files in this transfer">
        {session.files.map((f) => <FileRow key={f.fileId} engine={engine} f={f} />)}
      </ul>
    </div>
  );
}

const STATUS_TEXT: Record<FileSnapshot['status'], string> = {
  receiving: 'Receiving',
  verifying: 'Verifying…',
  verified: '✓ Verified',
  'hash-mismatch': '✕ Failed verification',
};

export function FileRow({ engine, f }: { engine: ReceiverEngine; f: FileSnapshot }) {
  const bitmap = engine.bitmap(f.sessionId, f.fileId);
  const segs = bitmap ? bitmapToSegments(bitmap) : new Uint8Array(0);
  const pct = Math.floor(f.progress * 1000) / 10;
  return (
    <li className={`rx-file status-${f.status}`}>
      <div className="row-between">
        <span className="file-name" title={f.displayName}>{f.displayName}</span>
        <span className={`badge badge-${f.status}`}>{STATUS_TEXT[f.status]}</span>
      </div>
      <SegmentedBar
        states={segs}
        version={f.receivedChunks}
        label={`${f.displayName} chunks received`}
        filled={f.receivedChunks}
        valueText={`${f.receivedChunks} of ${f.chunkCount} chunks, ${pct}%`}
      />
      <div className="row-between small">
        <span className="muted">{formatBytes(f.storedBytes)} of {formatBytes(f.fileSize)} · {f.receivedChunks.toLocaleString()}/{f.chunkCount.toLocaleString()} chunks</span>
        <span className="muted">{pct}%</span>
      </div>
      <TransferSpeed f={f} />
      {f.status === 'verified' && <FileActions engine={engine} f={f} allowDelete />}
      {f.status === 'hash-mismatch' && (
        <div className="button-row">
          <button type="button" className="btn" onClick={() => void engine.resetFile(f.sessionId, f.fileId)}>Discard and receive again</button>
        </div>
      )}
    </li>
  );
}
