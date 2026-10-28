/**
 * Send-rate benchmark: how fast can the sender cycle QR codes while the
 * receiver still captures them?
 *
 * Discrete-event simulation driven by REAL decodes:
 *  - Sender: the real TransferPlan pass (manifest held 2×), each code shown for `intervalMs`.
 *  - Camera: `cameraFps` frames with a rolling shutter (row y is read `y/H × readoutMs`
 *    after the frame starts) and an exposure window, so frames taken across a code
 *    switch are torn/blended exactly as on a phone. Sensor noise per frame.
 *  - Scanner: mirrors src/features/receiver/scanner.ts — one decode in flight, at most
 *    `maxFps` attempts/s, same crop (85% square) and downscale, same smoothing + modified
 *    jsQR (decodeWithJsQr). Decode time is measured for real and multiplied by
 *    `deviceFactor` to model slower phones; a busy scanner skips camera frames.
 *  - Receiver: the real ReceiverEngine, which must verify the file (SHA-256).
 *
 * Usage: npx tsx bench/sendrate/sim.ts [--quick]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryChunkStore } from '../../src/protocol/chunk-store.ts';
import { ReceiverEngine } from '../../src/protocol/receiver.ts';
import { prepareTransfer, type PacketRef, type TransferPlan } from '../../src/protocol/sender.ts';
import { bytesSource } from '../../src/protocol/source.ts';
import { frameForQr } from '../../src/protocol/transport.ts';
import { encodeQr } from '../../src/qr/encoder.ts';
import { decodeWithJsQr } from '../../src/qr/decoders/jsqr-core.ts';
import { decodeWithZxing, loadZxing } from '../../src/qr/decoders/zxing-core.ts';
import type { ScanHit } from '../../src/qr/decoders/types.ts';
import { frameThumb, isSameFrame } from '../../src/features/receiver/dedupe.ts';
import { acceptHit, nextScanGap } from '../../src/features/receiver/scanner.ts';
import { scanRegion, targetScanSide } from '../../src/features/receiver/region.ts';
import { DEFAULT_SETTINGS, resolveQrConfig } from '../../src/features/sender/settings.ts';

export interface SimConfig {
  intervalMs: number;
  maxFps: number;
  deviceFactor: number;
  cameraFps?: number;
  readoutMs?: number;
  exposureMs?: number;
  noiseSigma?: number;
  maxPasses?: number;
  /** Randomise the scanner's gap ±25% like FrameScanner (nextScanGap). */
  jitter?: boolean;
  seed: number;
  /** Decoder (default jsQR, as when the benchmark was written). */
  decoder?: 'jsqr' | 'zxing';
  /** Main-thread cost per scan (draw + read back + locate), ms before deviceFactor. Default 0. */
  captureMs?: number;
  /** Capture the next frame while the previous decodes (never queueing: only if the decoder is free when capture ends). */
  pipeline?: boolean;
  /** Skip decoding a frame whose 32×32 thumbnail matches the last successfully decoded frame (src/features/receiver/dedupe.ts). */
  dedupe?: boolean;
}

export interface SimResult {
  masks: 'fixed' | 'rotating';
  jitter: boolean;
  intervalMs: number;
  maxFps: number;
  deviceFactor: number;
  seed: number;
  dataCodes: number;
  passMs: number;
  /** Fraction of data codes captured during the first pass. */
  firstPassCoverage: number;
  /** Sender time until the receiver verified the file (null = not within maxPasses). */
  completeMs: number | null;
  passesNeeded: number | null;
  /** File bytes / completeMs. */
  goodputBps: number | null;
  /** Best possible: payload bytes / pass time. */
  theoreticalBps: number;
  scans: number;
  /** Frames captured but not decoded because they matched the last decoded frame (dedupe). */
  dupSkips: number;
  tornFrames: number;
  /** Torn frames that still decoded to a packet. */
  tornDecoded: number;
  avgDecodeMs: number;
  /** The engine's own per-file timing (first captured chunk → verified), as the app displays it. */
  fileElapsedMs: number | null;
}

export interface Prepared {
  plan: TransferPlan;
  frames: PacketRef[];
  durations: number[]; // in units of intervalMs (manifest = 2)
  /** views[variant][frameIndex]: camera view of each code; variant = pass % VARIANTS. */
  views: Uint8Array[][];
  packets: Uint8Array[];
  w: number;
  h: number;
  version: number;
  fileSize: number;
}

const VARIANTS = 3;
const VSYNC_MS = 1000 / 60;

let noiseTable: Int8Array | null = null;
function noise(): Int8Array {
  if (noiseTable) return noiseTable;
  // Gaussian (σ = 1 unit × 16) via Box–Muller, stored ×16 to keep integer math.
  const n = 1 << 22;
  const t = new Int8Array(n);
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) + 1) / 0x80000000;
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(rnd()));
    const a = 2 * Math.PI * rnd();
    t[i] = Math.max(-127, Math.min(127, Math.round(r * Math.cos(a) * 16)));
    t[i + 1] = Math.max(-127, Math.min(127, Math.round(r * Math.sin(a) * 16)));
  }
  return (noiseTable = t);
}

/** Build a real transfer (default settings: Conservative, text-safe) and pre-render camera views. */
/**
 * @param rotateMasks model a sender that uses a different QR mask each pass
 *   (pass variant v uses mask (auto + 3v) mod 8) — same content, different module pattern.
 */
export async function prepare(seed: number, dataCodes = 40, w = 1280, h = 720, rotateMasks = false): Promise<Prepared> {
  const cfg = resolveQrConfig(DEFAULT_SETTINGS);
  const fileSize = cfg.chunkSize * dataCodes - 17;
  const data = new Uint8Array(fileSize).map((_, i) => (i * 131 + seed * 7) & 0xff);
  const plan = await prepareTransfer([{ name: 'bench.bin', source: bytesSource(data) }], {
    chunkSize: cfg.chunkSize, maxManifestPacketBytes: cfg.maxPacketBytes, sessionId: Uint8Array.from([seed, 1, 2, 3, 4, 5, 6, 7]),
  });
  const frames = [...plan.pass({ strategy: DEFAULT_SETTINGS.strategy, manifestEvery: DEFAULT_SETTINGS.manifestEvery })];
  const durations = frames.map((f) => (f.kind === 'manifest' && DEFAULT_SETTINGS.holdManifest ? 2 : 1));
  const packets = await Promise.all(frames.map((f) => plan.packet(f)));
  const toBits = (m: { size: number; modules: Uint8Array }) => ({ size: m.size, bits: Array.from(m.modules, (v) => (v ? '1' : '0')).join('') });
  const auto = packets.map((p) => encodeQr(frameForQr(p, cfg.transport), { ecc: cfg.ecc, minVersion: cfg.version }));
  const codes = auto.map(toBits);
  const codesByVariant = rotateMasks
    ? Array.from({ length: VARIANTS }, (_, v) => packets.map((p, i) => toBits(encodeQr(frameForQr(p, cfg.transport), { ecc: cfg.ecc, minVersion: cfg.version, mask: (auto[i]!.mask + 3 * v) % 8 }))))
    : undefined;
  const dir = mkdtempSync(join(tmpdir(), 'sendrate-'));
  const out = join(dir, 'views.bin');
  const r = spawnSync('python3', ['bench/sendrate/render_views.py'], { input: JSON.stringify({ w, h, seed, variants: VARIANTS, out, codes, ...(codesByVariant ? { codesByVariant } : {}) }), encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(r.stderr);
  const raw = readFileSync(out);
  rmSync(dir, { recursive: true, force: true });
  const views = Array.from({ length: VARIANTS }, (_, v) => codes.map((_, i) => new Uint8Array(raw.buffer, raw.byteOffset + (v * codes.length + i) * w * h, w * h)));
  return { plan, frames, durations, views, packets, w, h, version: cfg.version, fileSize };
}

export async function simulate(p: Prepared, c: SimConfig, masks: 'fixed' | 'rotating' = 'fixed'): Promise<SimResult> {
  const fps = c.cameraFps ?? 30;
  const readout = c.readoutMs ?? 20;
  const exposure = c.exposureMs ?? 12;
  const sigma = c.noiseSigma ?? 5;
  const maxPasses = c.maxPasses ?? 5;
  const I = c.intervalMs;

  // Display timeline. Nominal starts per pass; actual switches snap to the next 60 Hz
  // vsync after the timer fires (timer jitter 0–4 ms), like a browser tab.
  const starts: number[] = [];
  let acc = 0;
  for (const d of p.durations) { starts.push(acc); acc += d * I; }
  const passMs = acc;
  let rngState = c.seed * 7919 + 17;
  const rnd = () => ((rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const switches: number[] = []; // global display k starts at switches[k]
  for (let pass = 0; pass <= maxPasses; pass++) {
    for (const st of starts) switches.push(Math.ceil((pass * passMs + st + rnd() * 4) / VSYNC_MS) * VSYNC_MS);
  }
  const n = p.durations.length;
  const codeAt = (t: number): { idx: number; end: number; variant: number } => {
    let lo = 0, hi = switches.length - 2;
    if (t < switches[0]!) return { idx: n - 1, end: switches[0]!, variant: 0 }; // blank before start ≈ last code
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (switches[mid]! <= t) lo = mid; else hi = mid - 1; }
    return { idx: lo % n, end: switches[lo + 1]!, variant: Math.floor(lo / n) % VARIANTS };
  };
  // Camera clock drifts slightly against the screen (±0.2%) with ±1 ms timestamp jitter.
  const camPeriod = (1000 / fps) * (1 + (rnd() - 0.5) * 0.004);

  let simNow = 0;
  const engine = new ReceiverEngine({ store: new MemoryChunkStore(), now: () => simNow });
  // Same region logic as FrameScanner: guide square (85%), switching to the full frame
  // after 2 consecutive scans with no code, and sticking with whichever region sees codes.
  const regions = [scanRegion(p.w, p.h, 0.85, targetScanSide(p.version)), scanRegion(p.w, p.h, 1, targetScanSide(p.version))];
  let regionMode = 0;
  let missesInMode = 0;
  const nt = noise();
  const dataIdx = new Set(p.frames.map((f, i) => (f.kind === 'data' ? i : -1)).filter((i) => i >= 0));
  const capturedFirstPass = new Set<number>();
  let scans = 0, torn = 0, tornDecoded = 0, dupSkips = 0, decodeTotal = 0, completeMs: number | null = null;
  // Sequential (today): one scan at a time; capture + decode keep the scanner busy.
  // Pipelined: capture (main thread) and decode (worker) overlap; a capture starts only if the
  // decoder will be free when it ends, so frames never queue (latest wins).
  let captureFreeAt = 0, decodeFreeAt = 0, lastAttempt = -Infinity;
  const nextGap = () => (c.jitter ? nextScanGap(c.maxFps, rnd) : 1000 / c.maxFps);
  let gap = nextGap();
  const phase = rnd() * camPeriod;
  const sigma16 = sigma; // noise table values are N(0,1)×16 → scale by sigma/16 using integer math below
  const captureCost = (c.captureMs ?? 0) * c.deviceFactor;
  const decoder = c.decoder ?? 'jsqr';
  let lastThumb: Float32Array | null = null;

  for (let j = 0; ; j++) {
    const tf = phase + j * camPeriod + (rnd() - 0.5) * 2;
    if (tf > maxPasses * passMs) break;
    if (tf < captureFreeAt || tf - lastAttempt < gap) continue;
    if (c.pipeline ? decodeFreeAt > tf + captureCost : tf < decodeFreeAt) continue;
    lastAttempt = tf;
    captureFreeAt = tf + captureCost;

    // Compose the cropped frame with rolling shutter + exposure blending.
    const { sx, sy, sSize, dSize } = regions[regionMode]!;
    const crop = new Uint8Array(sSize * sSize);
    let isTorn = false;
    for (let y = 0; y < sSize; y++) {
      const fy = sy + y;
      const ts = tf + (fy / p.h) * readout;
      const { idx, end, variant } = codeAt(ts);
      const a = p.views[variant]![idx]!;
      const rowOff = fy * p.w + sx;
      const dst = y * sSize;
      if (ts + exposure <= end) {
        crop.set(a.subarray(rowOff, rowOff + sSize), dst);
      } else {
        isTorn = true;
        const nx = codeAt(end + 0.001);
        const next = p.views[nx.variant]![nx.idx]!;
        const wOld = Math.max(0, Math.min(1, (end - ts) / exposure));
        const wo = Math.round(wOld * 256), wn = 256 - wo;
        for (let x = 0; x < sSize; x++) crop[dst + x] = (a[rowOff + x]! * wo + next[rowOff + x]! * wn) >> 8;
      }
    }
    // Downscale (area average) to the scanner's decode size, add sensor noise, RGBA.
    const rgba = new Uint8ClampedArray(dSize * dSize * 4);
    const scale = sSize / dSize;
    let nOff = Math.floor(rnd() * (nt.length - dSize * dSize - 1));
    for (let y = 0; y < dSize; y++) {
      const y0 = Math.floor(y * scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
      for (let x = 0; x < dSize; x++) {
        const x0 = Math.floor(x * scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
        let sum = 0, cnt = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += crop[yy * sSize + xx]!; cnt++; }
        const v = sum / cnt + (nt[nOff++]! * sigma16) / 16;
        const k = (y * dSize + x) * 4;
        rgba[k] = rgba[k + 1] = rgba[k + 2] = v;
        rgba[k + 3] = 255;
      }
    }

    const thumb = c.dedupe ? frameThumb(rgba, dSize) : null;
    if (thumb && lastThumb && isSameFrame(thumb, lastThumb)) {
      dupSkips++;
      gap = 0; // look again on the next camera frame, like a frame the locator skipped
      continue;
    }
    if (isTorn) torn++;

    // Decode exactly as the scan worker does; time it for real.
    const t0 = performance.now();
    const hit: ScanHit | null = decoder === 'zxing' ? await decodeWithZxing({ data: rgba, width: dSize, height: dSize }) : decodeWithJsQr({ data: rgba, width: dSize, height: dSize });
    const decodeMs = (performance.now() - t0) * c.deviceFactor;
    decodeTotal += decodeMs;
    scans++;
    gap = nextGap();
    const decodeStart = c.pipeline ? Math.max(captureFreeAt, decodeFreeAt) : captureFreeAt;
    decodeFreeAt = decodeStart + decodeMs;
    if (!c.pipeline) captureFreeAt = decodeFreeAt;
    const pkt = hit ? acceptHit(hit) : null;
    if (pkt || hit) missesInMode = 0;
    else if (++missesInMode >= 2) { missesInMode = 0; regionMode = (regionMode + 1) % 2; }
    if (!pkt) continue;
    if (thumb) lastThumb = thumb;
    if (isTorn) tornDecoded++;
    simNow = decodeFreeAt;
    const res = await engine.ingest(pkt);
    // Which code was it? (match bytes against the plan's packets)
    const which = p.packets.findIndex((q) => q.length === pkt.length && q.every((v, i) => v === pkt[i]));
    if (which >= 0 && dataIdx.has(which) && decodeFreeAt < passMs) capturedFirstPass.add(which);
    if (res.status === 'accepted' && res.fileStatus === 'verified') { completeMs = decodeFreeAt; break; }
  }

  const payload = p.fileSize;
  return {
    masks,
    jitter: !!c.jitter,
    intervalMs: I, maxFps: c.maxFps, deviceFactor: c.deviceFactor, seed: c.seed,
    dataCodes: dataIdx.size,
    passMs,
    firstPassCoverage: capturedFirstPass.size / dataIdx.size,
    completeMs,
    passesNeeded: completeMs === null ? null : completeMs / passMs,
    goodputBps: completeMs === null ? null : (payload * 1000) / completeMs,
    theoreticalBps: (payload * 1000) / passMs,
    scans, dupSkips, tornFrames: torn, tornDecoded,
    avgDecodeMs: scans ? decodeTotal / scans : 0,
    fileElapsedMs: completeMs === null ? null : engine.snapshot()[0]?.files[0]?.timing.elapsedMs ?? null,
  };
}

/** Load ZXing for the simulator (Node: bytes from disk). */
export async function loadZxingForSim(): Promise<void> {
  const b = readFileSync('src/vendor/zxing-wasm/zxing_reader.wasm');
  await loadZxing({ wasmBinary: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
}

// ── CLI: sweep ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const quick = process.argv.includes('--quick');
  const tuned = process.argv.includes('--tuned'); // new defaults: rotating masks + scan jitter
  const intervals = quick ? [750, 250] : [1000, 750, 500, 400, 300, 250, 200, 150, 100];
  const caps = quick ? [12] : [12, 30];
  const factors = quick ? [1] : [1, 3];
  const seedArg = process.argv.indexOf('--seed');
  const seeds = seedArg > 0 ? [Number(process.argv[seedArg + 1])] : quick ? [1] : [1, 2, 3];
  const results: SimResult[] = [];
  if (tuned) {
    for (const seed of seeds) {
      const prep = await prepare(seed, 40, 1280, 720, true);
      for (const deviceFactor of [1, 3]) for (const intervalMs of [300, 250, 200, 150, 100]) {
        const r = await simulate(prep, { intervalMs, maxFps: 12, deviceFactor, seed, jitter: true }, 'rotating');
        results.push(r);
        process.stderr.write(`seed ${seed} tuned ×${deviceFactor} ${intervalMs} ms → first pass ${(r.firstPassCoverage * 100).toFixed(0)}%, done ${r.completeMs === null ? '—' : (r.completeMs / 1000).toFixed(1) + ' s'} (${r.passesNeeded?.toFixed(2) ?? '—'} passes), torn ${r.tornFrames}/${r.scans}\n`);
      }
    }
    writeFileSync(`bench/sendrate/tuned-seed${seeds[0]}.json`, JSON.stringify(results, null, 1));
    process.exit(0);
  }
  for (const seed of seeds) {
    for (const masks of ['fixed', 'rotating'] as const) {
      const prep = await prepare(seed, 40, 1280, 720, masks === 'rotating');
      for (const deviceFactor of factors) for (const maxFps of caps) {
        if (masks === 'rotating' && maxFps !== 12) continue; // compare masks at the app's default cap
        for (const intervalMs of intervals) {
          const r = await simulate(prep, { intervalMs, maxFps, deviceFactor, seed }, masks);
          results.push(r);
          process.stderr.write(`seed ${seed} ${masks} ×${deviceFactor} cap ${maxFps}/s ${intervalMs} ms → first pass ${(r.firstPassCoverage * 100).toFixed(0)}%, done ${r.completeMs === null ? '—' : (r.completeMs / 1000).toFixed(1) + ' s'} (${r.passesNeeded?.toFixed(2) ?? '—'} passes), decode ${r.avgDecodeMs.toFixed(0)} ms, torn ${r.tornFrames}/${r.scans}\n`);
        }
      }
    }
  }
  writeFileSync(seedArg > 0 ? `bench/sendrate/results-seed${seeds[0]}.json` : 'bench/sendrate/results.json', JSON.stringify(results, null, 1));
}
