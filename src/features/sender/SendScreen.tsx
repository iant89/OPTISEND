import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { prepareTransfer, type TransferPlan } from '../../protocol/sender.ts';
import { blobSource } from '../../protocol/source.ts';
import { frameForQr } from '../../protocol/transport.ts';
import { PAYLOAD_PRESETS, type EccLevel } from '../../qr/capacity.ts';
import type { QrMatrix } from '../../qr/encoder.ts';
import { QrCanvas } from '../../components/QrCanvas.tsx';
import { HashClient, QrEncoderClient } from '../../workers/clients.ts';
import { formatBytes, formatDuration, formatRate, pluralize } from '../../utils/format.ts';
import {
  estimateTransfer, FAST_INTERVAL_MS, INTERVAL_CHOICES, PASS_CHOICES, resolveQrConfig, type PresetChoice, type ResolvedQrConfig, type SenderSettings,
} from './settings.ts';
import type { PassCount } from './scheduler.ts';

export interface QueuedFile {
  id: string;
  file: File;
}

interface Props {
  queue: QueuedFile[];
  setQueue: (q: QueuedFile[]) => void;
  settings: SenderSettings;
  setSettings: (s: SenderSettings) => void;
  onStart: (plan: TransferPlan, cfg: ResolvedQrConfig) => void;
  onBack: () => void;
}

// Hashes are cached per File object so changing settings never re-hashes.
const hashCache = new WeakMap<File, Promise<Uint8Array>>();
let hashClient: HashClient | null = null;
let previewEncoder: QrEncoderClient | null = null;

let idSeq = 0;
export function queueFiles(existing: QueuedFile[], files: Iterable<File>): QueuedFile[] {
  const sig = (f: File) => `${f.name}\u0000${f.size}\u0000${f.lastModified}\u0000${f.type}`;
  const seen = new Set(existing.map((q) => sig(q.file)));
  const added: QueuedFile[] = [];
  for (const f of files) {
    if (seen.has(sig(f))) continue; // the exact same file picked twice
    seen.add(sig(f));
    added.push({ id: `f${++idSeq}`, file: f });
  }
  return [...existing, ...added];
}

type HashState = { hashed: number; done: boolean; error?: string };

export function SendScreen({ queue, setQueue, settings, setSettings, onStart, onBack }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hashes, setHashes] = useState<Record<string, HashState>>({});
  const [plan, setPlan] = useState<TransferPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [preview, setPreview] = useState<QrMatrix | null>(null);

  const cfg = useMemo(() => resolveQrConfig(settings), [settings]);
  const estimate = useMemo(() => estimateTransfer(queue.map((q) => q.file), settings), [queue, settings]);
  const update = (patch: Partial<SenderSettings>) => setSettings({ ...settings, ...patch });

  // ── Hash every queued file (worker, cached) ──
  useEffect(() => {
    hashClient ??= new HashClient();
    for (const q of queue) {
      if (hashCache.has(q.file)) {
        void hashCache.get(q.file)!.then(
          () => setHashes((h) => (h[q.id]?.done ? h : { ...h, [q.id]: { hashed: q.file.size, done: true } })),
          (e: Error) => setHashes((h) => ({ ...h, [q.id]: { hashed: 0, done: false, error: e.message } })),
        );
        continue;
      }
      const p = hashClient.hash(q.file, (n) => setHashes((h) => ({ ...h, [q.id]: { hashed: n, done: false } })));
      hashCache.set(q.file, p);
      p.then(
        () => setHashes((h) => ({ ...h, [q.id]: { hashed: q.file.size, done: true } })),
        (e: Error) => {
          hashCache.delete(q.file);
          setHashes((h) => ({ ...h, [q.id]: { hashed: 0, done: false, error: `Could not read this file: ${e.message}` } }));
        },
      );
    }
  }, [queue]);

  const allHashed = queue.length > 0 && queue.every((q) => hashes[q.id]?.done);

  // ── Build the plan + first-frame preview once hashes are ready ──
  useEffect(() => {
    setPlan(null);
    setPreview(null);
    setPlanError(null);
    if (!allHashed || !estimate.valid) return;
    let cancelled = false;
    (async () => {
      try {
        const inputs = await Promise.all(
          queue.map(async (q) => ({ name: q.file.name, mimeType: q.file.type, source: blobSource(q.file), fileHash: await hashCache.get(q.file)! })),
        );
        const p = await prepareTransfer(inputs, { chunkSize: cfg.chunkSize, maxManifestPacketBytes: cfg.maxPacketBytes });
        if (cancelled) return;
        setPlan(p);
        previewEncoder ??= new QrEncoderClient();
        const m = await previewEncoder.encode(frameForQr(p.manifestPackets[0]!, cfg.transport), cfg.ecc, cfg.version);
        if (!cancelled) setPreview(m);
      } catch (e) {
        if (!cancelled) setPlanError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [allHashed, queue, cfg, estimate.valid]);

  // ── File selection ──
  const add = (files: FileList | null) => {
    if (files && files.length) setQueue(queueFiles(queue, Array.from(files)));
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    add(e.currentTarget.files);
    e.currentTarget.value = ''; // allow picking the same file again after removal
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragging(false);
    add(e.dataTransfer.files);
  };
  const remove = (id: string) => setQueue(queue.filter((q) => q.id !== id));

  const hashingBytes = queue.reduce((n, q) => n + (hashes[q.id]?.hashed ?? 0), 0);
  const status = queue.length === 0
    ? 'Add files to see the transfer estimate.'
    : planError ?? estimate.problem ?? (!allHashed ? `Preparing… ${Math.floor((hashingBytes / Math.max(1, estimate.totalBytes)) * 100)}%` : plan ? 'Ready to transmit.' : 'Preparing…');

  return (
    <main className="screen send-screen" onDragOver={(e: DragEvent<HTMLElement>) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <header className="screen-header">
        <button type="button" className="btn btn-ghost" onClick={onBack} aria-label="Back to home">← Back</button>
        <h1>Send files</h1>
      </header>

      <section className={`card dropzone ${dragging ? 'is-dragging' : ''}`} aria-labelledby="files-h">
        <h2 id="files-h" className="visually-hidden">Files</h2>
        <input ref={inputRef} id="file-input" type="file" multiple onChange={onPick} className="visually-hidden" />
        <div className="dropzone-body">
          <label htmlFor="file-input" className="btn btn-primary btn-lg">Choose files</label>
          <p className="muted drop-hint">or drop them here</p>
        </div>

        {queue.length > 0 && (
          <>
            <ul className="file-list" aria-label="Selected files">
              {queue.map((q, i) => {
                const h = hashes[q.id];
                return (
                  <li key={q.id} className="file-row">
                    <span className="file-index" aria-hidden="true">{i + 1}</span>
                    <span className="file-meta">
                      <span className="file-name" title={q.file.name}>{q.file.name || 'Unnamed file'}</span>
                      <span className="file-sub muted">
                        {formatBytes(q.file.size)}
                        {h?.error ? <span className="error-text"> · {h.error}</span> : h?.done ? ' · ready' : ` · preparing ${Math.floor(((h?.hashed ?? 0) / Math.max(1, q.file.size)) * 100)}%`}
                      </span>
                    </span>
                    <button type="button" className="btn btn-ghost btn-icon" onClick={() => remove(q.id)} aria-label={`Remove ${q.file.name}`}>✕</button>
                  </li>
                );
              })}
            </ul>
            <div className="row-between">
              <span className="muted">{pluralize(queue.length, 'file')} · {formatBytes(estimate.totalBytes)}</span>
              <button type="button" className="btn btn-ghost" onClick={() => setQueue([])}>Clear all</button>
            </div>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="settings-h">
        <h2 id="settings-h">Transmission</h2>

        <fieldset className="field">
          <legend>QR density</legend>
          <div className="choice-grid">
            {(['conservative', 'balanced', 'high-throughput', 'custom'] as PresetChoice[]).map((id) => (
              <label key={id} className={`choice ${settings.preset === id ? 'is-selected' : ''}`}>
                <input type="radio" name="preset" value={id} checked={settings.preset === id} onChange={() => update({ preset: id })} />
                <span className="choice-title">{id === 'custom' ? 'Custom' : PAYLOAD_PRESETS[id].label}</span>
                <span className="choice-sub muted">{id === 'custom' ? 'Pick version, error correction and payload' : PAYLOAD_PRESETS[id].description}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {settings.preset === 'custom' && (
          <div className="field-row">
            <label className="field">
              <span>QR version (1–40)</span>
              <input type="number" min={1} max={40} value={settings.customVersion} onChange={(e: ChangeEvent<HTMLInputElement>) => update({ customVersion: clamp(parseInt(e.currentTarget.value, 10), 1, 40) })} />
            </label>
            <label className="field">
              <span>Error correction</span>
              <select value={settings.customEcc} onChange={(e: ChangeEvent<HTMLSelectElement>) => update({ customEcc: e.currentTarget.value as EccLevel })}>
                <option value="L">L · ~7% recovery</option>
                <option value="M">M · ~15%</option>
                <option value="Q">Q · ~25%</option>
                <option value="H">H · ~30%</option>
              </select>
            </label>
            <label className="field">
              <span>Payload limit (bytes, 0 = max)</span>
              <input type="number" min={0} max={4096} value={settings.customPayload} onChange={(e: ChangeEvent<HTMLInputElement>) => update({ customPayload: clamp(parseInt(e.currentTarget.value, 10), 0, 4096) })} />
            </label>
          </div>
        )}

        <fieldset className="field">
          <legend>Time per code</legend>
          <div className="chips">
            {INTERVAL_CHOICES.map((ms) => (
              <label key={ms} className={`chip ${settings.intervalMs === ms ? 'is-selected' : ''}`}>
                <input type="radio" name="interval" checked={settings.intervalMs === ms} onChange={() => update({ intervalMs: ms })} />
                {ms < 1000 ? `${ms} ms` : `${ms / 1000} s`}
              </label>
            ))}
          </div>
          {settings.intervalMs < FAST_INTERVAL_MS && <p className="muted small">Fast: needs a receiver camera at 30 fps and good light. Use 100 ms if codes are missed.</p>}
        </fieldset>

        <fieldset className="field">
          <legend>Passes</legend>
          <div className="chips">
            {PASS_CHOICES.map((p) => (
              <label key={String(p)} className={`chip ${settings.passes === p ? 'is-selected' : ''}`}>
                <input type="radio" name="passes" checked={settings.passes === p} onChange={() => update({ passes: p as PassCount })} />
                {p === 'continuous' ? 'Loop until stopped' : `${p}×`}
              </label>
            ))}
          </div>
        </fieldset>

        <details className="advanced">
          <summary>Advanced</summary>
          <label className="field check">
            <input type="checkbox" checked={settings.transport === 'alphanumeric'} onChange={(e: ChangeEvent<HTMLInputElement>) => update({ transport: e.currentTarget.checked ? 'alphanumeric' : 'byte' })} />
            <span>Text-safe encoding <span className="muted">(Base45 · for receivers whose scanner only returns text · ~3% slower)</span></span>
          </label>
          <label className="field check">
            <input type="checkbox" checked={settings.colorLayers === 3} onChange={(e: ChangeEvent<HTMLInputElement>) => update({ colorLayers: e.currentTarget.checked ? 3 : 1 })} />
            <span>Colour: 3 codes per frame <span className="muted">(experimental · red, green and blue layers · the receiver needs this OptiSend version)</span></span>
          </label>
          <label className="field check">
            <input type="checkbox" checked={settings.strategy === 'round-robin'} onChange={(e: ChangeEvent<HTMLInputElement>) => update({ strategy: e.currentTarget.checked ? 'round-robin' : 'sequential' })} />
            <span>Interleave files <span className="muted">(round-robin, so small files finish sooner)</span></span>
          </label>
          <label className="field check">
            <input type="checkbox" checked={settings.holdManifest} onChange={(e: ChangeEvent<HTMLInputElement>) => update({ holdManifest: e.currentTarget.checked })} />
            <span>Show file-list codes twice as long</span>
          </label>
          <label className="field">
            <span>Repeat the file list every N codes (0 = once per pass)</span>
            <input type="number" min={0} max={100000} value={settings.manifestEvery} onChange={(e: ChangeEvent<HTMLInputElement>) => update({ manifestEvery: clamp(parseInt(e.currentTarget.value, 10), 0, 100000) })} />
          </label>
        </details>
      </section>

      <section className="card estimate" aria-labelledby="est-h" aria-live="polite">
        <h2 id="est-h">Estimate</h2>
        <dl className="stats">
          <div><dt>{settings.colorLayers > 1 ? 'Frames per pass' : 'QR codes per pass'}</dt><dd>{estimate.valid ? estimate.framesPerPass.toLocaleString() : '—'}</dd></div>
          <div><dt>Bytes per code</dt><dd>{estimate.chunkSize > 0 ? `${estimate.chunkSize.toLocaleString()}${settings.colorLayers > 1 ? ` × ${settings.colorLayers}` : ''}` : '—'}</dd></div>
          <div><dt>One pass</dt><dd>{estimate.valid ? formatDuration(estimate.passMs) : '—'}</dd></div>
          <div><dt>Passes</dt><dd>{settings.passes === 'continuous' ? 'Until stopped' : settings.passes}</dd></div>
          <div><dt>Total time</dt><dd>{!estimate.valid ? '—' : estimate.totalMs === null ? 'Loops' : formatDuration(estimate.totalMs)}</dd></div>
          <div><dt>Best-case rate</dt><dd>{estimate.valid ? formatRate(estimate.bytesPerSecond) : '—'}</dd></div>
        </dl>
        <p className="muted small">QR v{cfg.version}-{cfg.ecc} · {cfg.transport === 'byte' ? 'binary' : 'text-safe'} · a receiver that misses codes catches them on the next pass.</p>
      </section>

      <section className="card preview" aria-labelledby="prev-h">
        <h2 id="prev-h">First code</h2>
        <div className="preview-row">
          <div className="preview-qr">
            {preview ? <QrCanvas matrix={preview} label="Preview of the first QR code (file list)" maxCssPx={180} /> : <div className="preview-placeholder muted">{queue.length ? '…' : 'No files'}</div>}
          </div>
          <p className={`status-text ${planError || estimate.problem ? 'error-text' : 'muted'}`} role="status">{status}</p>
        </div>
      </section>

      <div className="sticky-actions">
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!plan} onClick={() => plan && onStart(plan, cfg)}>
          Start transfer
        </button>
      </div>
    </main>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
}
