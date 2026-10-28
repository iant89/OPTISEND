# OptiSend

Offline file transfer between devices using only a screen and a camera. No uploads, no accounts, no network during transfer.

| Phase | Status |
|-------|--------|
| 1 · Protocol foundation | ✅ done |
| 2 · Sender | ✅ done |
| 3 · Receiver (camera) | ✅ done |
| 4 · Storage & recovery | ✅ done |
| 5 · Reliability optimization | next (real-device testing, calibration, in-house decoder) |

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173 (esbuild, rebuilds on change)
npm run build        # static site in dist/ (deploy anywhere; camera needs HTTPS in Phase 3)
npm test             # 171 unit tests (node:test via tsx)
npm run test:e2e     # 19 browser tests (needs `npm run build`, Playwright Chromium, python3 + opencv)
npm run typecheck
```

GitHub Actions runs type checks, the build, unit and optical tests, QR capacity verification, and Chromium end-to-end tests on pushes and pull requests. CI uses Node.js 22, Python 3.11, NumPy, and OpenCV's contrib package; its browser tests run serially to reduce resource contention.

Runtime dependencies: `react`, `react-dom`, and two vendored QR decoders:
- ZXing-C++ as WebAssembly (`zxing-wasm` 3.1.5, MIT + Apache-2.0) in `src/vendor/zxing-wasm/`, unmodified. The build copies `zxing_reader.wasm` (about 950 KB) to `dist/assets/`, and the app loads it from there, never from a CDN.
- jsQR in `src/vendor/jsqr/` (Apache-2.0), performance-modified: about 2.4× faster and proven bit-identical to upstream (see the README there).

The QR encoder, SHA-256 and the protocol are in-house.

The camera only works on a secure page (https:// or localhost). To test on a phone, serve `dist/` over HTTPS.

### GitHub Pages

The Pages workflow builds and deploys `dist/` on pushes to `main`, or when run manually from the Actions tab. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. The deployed site is available at https://iant89.github.io/OPTISEND/ after a successful deployment.

## Phase 2 — Sender

- **Send screen:** native picker (multiple files), drag-and-drop on desktop, per-file remove / clear all, sizes and totals. Hashing runs in a Web Worker and is cached per file, so changing settings never re-hashes.
- **Settings:** density presets (Conservative v15-M · Balanced v25-M · High throughput v40-L) or custom version / ECC / payload limit; 50 ms–1.5 s per code (100 ms default; 66 and 50 ms are marked fast); 1, 2, 3 or 5 passes, or loop until stopped; sequential or interleaved files; manifest repeat interval; hold manifest frames 2×; text-safe vs binary transport. Settings persist in localStorage.
- **Estimate:** QR codes per pass, bytes per code, pass time, total time and best-case rate. These are computed before hashing, and a test checks they match the real plan frame for frame. A preview shows the first code.
- **Transmission view:** full-screen where supported, with the screen kept awake. The QR is drawn at whole device pixels per module, with the quiet zone and no blur or stretching. It shows file and chunk position, pass number and a segmented per-pass bar. Controls: pause/resume, previous/next, live interval change, Stop, Finish and Repeat pass. Keyboard: Space toggles pause, ←/→ step. It pauses automatically if the page is hidden, since a hidden page shows no code.
- **Honest completion:** the summary says what was displayed and states plainly that only the receiver can confirm a file is complete (spec §8.3).
- **Scheduler:** drift-free monotonic timing. If the page falls far behind it re-anchors rather than flashing a burst of frames, and it counts those resyncs.

## Phase 3 — Receiver

- **Camera:** the rear camera is preferred at 1080p, with continuous focus where supported. Errors map to clear help: permission denied, no camera, camera busy, not a secure page, not supported. Each has a working Try again. Tracks are stopped when leaving the screen.
- **Decoder plug-ins** (`src/qr/decoders/`): one `FrameDecoder` interface with a `DecoderChain`.
  - *Automatic*: ZXing-C++ (WebAssembly) in a worker first (raw bytes, so binary mode works everywhere), then the built-in `BarcodeDetector` where available. jsQR is used only if the WebAssembly cannot load (no WebAssembly support, CSP, or the file is missing).
  - *ZXing only*, *jsQR only*, *Built-in only*: single decoders, for testing. Each falls back to jsQR if its decoder is unavailable.
  - *Compare all*: runs every decoder on every frame and records reads, accepts, rescues and timings, shown under Scanner settings & diagnostics. Use it on real phones to confirm the simulated results below.
- **Scanning loop:** uses `requestVideoFrameCallback`, falling back to rAF. Every camera frame is a scan attempt (the old 12/s cap is gone, see below), never more than one decode in flight. It crops to the guide square and downscales to a size based on the QR version. It alternates with the full frame until a code is found, so a phone held too close still scans. Before jsQR it applies a 3×3 luminance smoothing pass, which in simulation raised v15 decoding from 15/24 to 21/24 frames and made it faster. Scanning pauses while the page is hidden.
- **Receive screen:** live preview with a scan guide, and a brief green pulse on each new chunk (none for duplicates). Each file gets a segmented bar, byte-based %, chunk counts and a status badge: Receiving, Verifying, ✓ Verified, or ✕ Failed with "Discard and receive again". It also shows valid, missing, duplicate and invalid counts, Pause/Resume and Stop. Screen-reader announcements and optional vibration fire when a file verifies.
- **Saving:** Save (object URL + download) and Share… (Web Share with files, which is the best path on iOS). MIME types are allow-listed; HTML and SVG always download as octet-stream. File names are sanitised.
- **App-level engine:** leaving the receive screen keeps partial and finished transfers. The home screen lists received files (with Save) and incomplete ones (with Resume). For now this lasts only while the page is open; Phase 4 adds IndexedDB.

### Measured readability (simulated 1080p phone camera)

Frames decoded out of 24, cropped as the scanner does (`tests/zxing-sim.test.ts`). Times are per decode in Node on this machine.

| Preset | Pose | jsQR | ZXing-C++ |
|---|---|---|---|
| Conservative v15-M | aimed | 21 (31 ms) | 24 (7 ms) |
| Conservative v15-M | hand-held | 20 | 22 |
| Balanced v25-M | aimed | 9 (35 ms) | 24 (7 ms) |
| Balanced v25-M | hand-held | 6 | 15 |
| High throughput v40-L | aimed | 0 (53 ms) | 16 (10 ms) |
| High throughput v40-L | hand-held | 0 | 5 |

jsQR never decoded a frame that ZXing missed. Balanced becomes dependable with ZXing; High throughput becomes usable with a steady, close camera.

The full browser loop (`e2e/receiver.test.ts`) screenshots the real sender app during a transfer, "films" it with a simulated hand-held camera, and plays that to a second Chromium as its webcam. With jsQR, the receiver app decoded 81 of 85 frames (95%); with ZXing it decodes every frame it tries, at about 6 ms each. Both files verify and save byte-for-byte in about 8 seconds of scanning. The test also checks that ZXing did the decoding and that the page made no requests outside the app; a second test blocks the WebAssembly and checks the receiver falls back to jsQR.

## Phase 4 — Storage & recovery

- **IndexedDB** (`src/storage/idb.ts`), database `optisend` v1. It has three object stores:
  - `chunks`: key `[sessionId, fileId, index]`, value the payload.
  - `chunkMeta`: the same key, value the byte length, so restore can list chunks without loading them.
  - `sessions`: the engine metadata (bitmaps, fingerprints, status, names, deleted ids).

  A chunk write resolves only when its transaction commits, with `durability: 'strict'`. Failed requests abort the transaction, so a chunk that didn't land is never counted.
- **Saving state:** the engine emits change events. `ReceiverStorage` saves metadata within 400 ms of a change, and immediately when the page is hidden or closed.
- **Restoring:** reconciliation treats the stored chunks as the source of truth.
  - A chunk the saved state claims but storage lost (browser eviction) is counted as lost and received again.
  - A chunk written after the last metadata save (the page died in between) is recovered by re-hashing it.
  - A file that becomes complete through recovery gets its full-file SHA-256 check.
  - Corrupt saved records are validated and discarded.
- **Survives reloads:** partial progress, names and types, verified files, hash-mismatch state and deleted files all persist. A deleted file stays deleted even if the sender keeps looping.
- **Storage management (home screen):**
  - Received files with Save, Save as…, Share and Delete. Delete asks for confirmation.
  - Incomplete transfers with progress, missing chunks, last activity, Resume and Delete.
  - Storage figures: received, incomplete, OptiSend total and browser quota left.
  - "Keep files on this device" (`navigator.storage.persist()`) and "Clear all data…" with a two-step confirmation.
  - A notice when a reload restored transfers, including lost or recovered chunks.
- **Errors:**
  - A full quota shows a "Storage is full" banner on the receive screen with what to do. The affected chunks stay eligible for the next pass.
  - A warning appears before scanning when the rest of a transfer won't fit in the available quota.
  - Failed metadata saves are reported on the home screen.
  - If IndexedDB is unavailable, OptiSend falls back to memory and says so clearly.
- **Save as…** (File System Access API, desktop Chromium) streams the file chunk by chunk to disk, so memory use stays bounded. If it fails partway, the partial file is aborted.
- **"Transfers in progress" limit:** only unfinished transfers count towards it. Finished ones stay listed until you delete them.

Tests: `tests/persistence.test.ts` (save/restore, eviction, crash recovery, deletes, corrupt records), `e2e/storage.test.ts` (real IndexedDB in Chromium, a real reload, and genuine quota exhaustion via DevTools `Storage.overrideQuotaForOrigin`) and `e2e/recovery.test.ts`. The last one is the whole app: a camera transfer interrupted by a reload resumes from IndexedDB; verified files persist across reloads and save byte-for-byte; and delete and clear-all work and survive reloads. It also checks the full-storage banner.

### Per-file transfer speed
Each file's clock starts when its **first chunk is captured** and stops when the file is **verified**. It runs only while the receiver is actively scanning: pausing, leaving the receive screen, a hidden page, or the gap between closing and reopening the app are not counted. Timing is saved, so it survives reloads.

- While receiving: "Receiving for 42s · 310 B/s", using stored bytes ÷ active time. It appears after 1 s of data.
- Once verified: "Received in 1m 03s · 412 B/s", using file size ÷ active time.
- Files that fit in a single capture (or are empty) show "Received instantly" instead of a meaningless rate. Failed files show no rate.
- The clock starts at the *capture* of the first chunk, so the first chunk's own display time isn't counted. This slightly overstates the rate for files of only a few chunks and is negligible for larger ones.

### Send-rate tuning (from `bench/sendrate/REPORT.md`)
- **200 ms per code by default:** about 3× faster than the old 750 ms with similar reliability, validated in the real app. Saved settings that still held the old 750 ms default move to 200 ms; other saved choices are kept.
- **QR mask rotates every pass:** `maskOffsetForPass`. Same packet, different module pattern, so a code that's unreadable at a given camera angle becomes readable on the next pass. Receivers need no change.
- **Scanner gap jitter of ±25%:** `nextScanGap`. Stops the camera, the scan cap and the sender interval locking in phase on torn frames.
- **Storage hardening found along the way:**
  - A new transfer's record is saved immediately rather than after the 400 ms debounce, so its chunks can always be reattached after a reload.
  - Chunks with no saved record are reclaimed when the app opens.

### QR locator (`src/qr/detect/finder.ts`)
Before decoding, the scanner looks for the code's three finder patterns in a half-size copy of the whole frame (about 5 ms), then decodes a tight crop around the code instead of a fixed square in the middle.

- **Finding:** local-threshold binarisation, a row scan for the finder's 1:1:3:1:1 run pattern, vertical, horizontal and diagonal cross-checks, then the three centres that form a QR-shaped right angle. It reports where the code is and its module size; it does not decode.
- **Cropping:** a square around the code at about 8 px per module. When jsQR is the decoder, a miss on a located code makes the next scan use the guide square instead; jsQR's failures on different crops are largely independent, and dense codes sometimes decode only in the larger crop. ZXing reads the tight crop at least as well as the guide square, so with ZXing the scanner stays on the tight crop.
- **Empty frames:** when no code is found the frame is skipped and the scanner looks again on the next camera frame. Every 3rd such frame is still decoded the old way (guide square, then whole frame), so a locator miss costs little.
- **Measured with jsQR** (`tests/locator-sim.test.ts`, 24 simulated 1080p frames each):

  | Preset | Pose | Guide square | Tight crop, then guide |
  |---|---|---|---|
  | Conservative v15 | aimed | 21/24 | 21/24 |
  | Conservative v15 | hand-held (off-centre, varied distance) | 9/24 | 21/24 |
  | Balanced v25 | aimed | 9/24 | 9/24 |
  | Balanced v25 | hand-held | 0/24 | 7/24 |

  No false positives on 24 busy non-QR screens.

### Colour mode (experimental): 3 QR codes per frame
Sender → Advanced → "Colour: 3 codes per frame". Each displayed frame overlays three ordinary QR codes, one per colour channel: code 1 drives red, code 2 green, code 3 blue (`compositeRgb` in `src/qr/render.ts`).
- **Same protocol.** Each code carries a normal OptiSend packet.
- **File list stays readable everywhere.** File-list frames are always black and white and shown alone, so any receiver can read them (`groupFrames` in `src/features/sender/frames.ts`).
- **Finders still work.** All codes in a frame have the same version, so the finder squares, timing and alignment patterns coincide and appear black. The locator and decoders work unchanged.

The receiver needs no setting (`src/qr/color.ts`):
- **Detection:** it checks the share of saturated pixels after stretching each channel to its own range, so a colour cast on a black-and-white code doesn't count as colour.
- **Unmixing:** it undoes the camera's colour mixing, estimated from the frame itself. The eight module colours (each channel dark or light) form eight clusters; k-means finds them, the structure of the colour cube labels them, and the inverse mix is applied.
- **Decoding:** each channel is decoded as a grey image. A channel that fails after unmixing is retried raw.
- **Off the main thread:** the colour fit and channel split (about 20–60 ms per colour frame) run in `colour.worker` (`src/qr/colour-splitter.ts`); the frame is transferred, not copied. Only the cheap colour check (about 1 ms) runs on the main thread. If the worker can't start, the split runs on the main thread. In the browser colour test, main-thread long tasks (≥ 50 ms) went from 9 (529 ms in total) to none.

Measured in simulation (`tests/color-sim.test.ts`; the camera model adds 20% crosstalk, ±15% white balance, Bayer sampling and 4:2:0 chroma), aimed, ZXing:

| Mode | Codes decoded | Data per frame |
|---|---|---|
| v25-M black and white | 11/12 | 778 B |
| v40-L black and white | 8/12 | 1,831 B |
| v25-M colour | 33/36 | 2,335 B |
| v30-L colour | 31/36 | 4,035 B |

In the browser test (`e2e/receiver.test.ts`), the same two files took 6 filmed frames instead of 14, and the 2.6 KB file arrived about 3× faster.

**Limits:**
- The camera model is an assumption: real screens, cameras, auto white balance and video compression decide. Test on real device pairs, with Compare-all diagnostics and the "colour frames" counter.
- Older OptiSend receivers read only the black-and-white file-list frames.

### Faster sending: 100 ms default, no scan cap, pipelined scanning
From `bench/sendrate/REPORT.md` ("With ZXing: the scan cap was the bottleneck"):
- **No scan cap:** with ZXing decoding in about 6 ms, the receiver looks at every camera frame. The 12/s cap, set for jsQR, made sending faster than about 100 ms per code fail.
- **Pipelined scanning:** the next frame is captured and located on the main thread while the previous one decodes in a worker. At most one captured frame waits, so there is never a backlog and the newest frame always wins. This is what keeps a 3× slower phone at 99–100% first-pass capture at 66–50 ms.
- **Repeat frames skipped:** a frame that looks the same as the last fully decoded one (32×32 thumbnail, `src/features/receiver/dedupe.ts`) isn't decoded again. This saves decodes and battery, not time. Shown in the diagnostics as "repeat frames skipped".
- **100 ms per code by default:** twice as fast as 200 ms, and every code is still captured in the first pass in the simulator, including a dim-light 15 fps camera. 66 ms and 50 ms are offered as fast options (the sender says they need a 30 fps camera and good light). Settings still on an earlier default (200 ms, or 750 ms from v1) move to 100 ms; other choices are kept.

### Fountain-coded repair passes (on by default)
Spec: `docs/PROTOCOL.md` §5a. Code: `src/protocol/fountain.ts`.

**What changes:**
- Pass 1 is unchanged: every chunk is sent as a data packet.
- From pass 2, the sender doesn't repeat chunks. Each frame instead carries a **repair code**: the XOR of a pseudo-random half of one block's chunks (blocks of at most 256 chunks).
- Any repair code of a block can fill any chunk of that block the receiver missed. Once it holds as many repair codes as missing chunks (occasionally a few more), it rebuilds them by Gaussian elimination over GF(2).
- Repair codes cycle through the blocks, so every block gets its share early in each pass.

**Safety:**
- Every repair code carries a SHA-256 of its payload and is checked before use.
- Rebuilt chunks are stored like received ones, and a file is `verified` only when its full SHA-256 matches.
- Repair packets use the reserved type `0x03`, which receivers from before this change reject while still reading pass 1. The setting is under Advanced on the Send screen ("Repair codes after the first pass").

**Frames and display:** each repair pass has the same frames as pass 1, so time estimates, colour mode and file-list repeats are unchanged. The sender labels repair frames "repair code", and the receiver shows a "Rebuilt" count.

**Measured:**
- **Unit test, 700-chunk file (3 blocks), 15% of pass 1 lost:** the 105 missing chunks were rebuilt from 151 repair codes, about a fifth of a pass. Repeating passes has to wait for those exact chunks to come round again.
- **Send-rate simulator, 40-chunk file:** fountain mode is never slower. When pass 1 misses codes (dim light, 15 fps camera, 66–50 ms per code), it finishes in 4.4–5.2 s instead of 5.5–6.3 s in 4 of 6 runs; in the other 2, both take the same time. When pass 1 catches everything, both are identical.
- **Browser test (`e2e/receiver.test.ts`):** three pass-1 frames are cut from the film. The receiver rebuilds exactly those 3 chunks from pass-2 repair codes and saves both files byte-for-byte.

### Default transport is text-safe (Base45)
The browser e2e test showed that desktop QR decoders return byte-mode content as *text* and cut it off at the first zero byte, so every binary frame was rejected (safely, by CRC/length checks). `BarcodeDetector.rawValue` and phone camera apps are text-only too. Text-safe mode works with any scanner and costs about 3% capacity. Binary mode stays available for receivers that read raw bytes.

## Layout

| Path | Purpose |
|------|---------|
| `src/protocol/` | Wire format, sender packetizer, receiver engine (Phase 1), fountain-code repair (`fountain.ts`) |
| `src/qr/encoder.ts` | QR Model 2 encoder: byte/alphanumeric, v1–40, L/M/Q/H, automatic masking |
| `src/qr/render.ts` | Crisp canvas rendering and layout math |
| `src/features/sender/` | Scheduler, settings/estimates, frame pipeline, Send and Transmit screens |
| `src/workers/` | Hash, QR-generation and scan (jsQR) workers, with automatic main-thread fallback |
| `src/qr/decoders/` | Decoder plug-in interface, chain with per-decoder stats, native + jsQR plug-ins |
| `src/qr/detect/` | Fast QR locator (finder patterns only, no decoding) |
| `src/camera/` | Camera open/close and error classification |
| `src/features/receiver/` | Scanner loop, scan-region geometry, Receive screen |
| `src/features/files/` | Save / Save as… (streaming) / Share / Delete for verified files |
| `src/storage/` | IndexedDB chunk + session stores, persistence wiring, storage estimates |
| `src/app/Home.tsx` | Received / incomplete transfers, storage panel, restore notice |
| `src/vendor/jsqr/` | Vendored jsQR (Apache-2.0) + types |
| `src/vendor/zxing-wasm/` | Vendored ZXing-C++ WebAssembly reader (MIT + Apache-2.0) + types |
| `src/components/` | `QrCanvas`, `SegmentedBar` (scales to tens of thousands of segments) |
| `e2e/` | Playwright tests and a pixel-exact QR reader used to verify binary frames |
| `docs/PROTOCOL.md` | Normative wire format |

## How it was verified

- **QR encoder:** module-for-module identical to OpenCV's encoder in 312 of 320 version × ECC × mode combinations. The other 8 are cases where OpenCV's own output doesn't decode; ours does. Auto-masked output decodes with two independent decoders, and RS, BCH and alignment values match ISO 18004 reference values.
- **Browser end to end:** the built app runs in Chromium. Every code it draws is captured from the canvas, decoded by OpenCV/WeChat, or by a pixel-exact reader that checks every Reed–Solomon block, and fed to the receiver engine. Four files rebuild byte-for-byte and verify: binary data, two different files both named `notes.txt`, and an empty file.
- **Accessibility checks:** every control is at least 44 px, all buttons are named, there's no horizontal scroll at 320 px, focus is visible, progress is announced through ARIA, and reduced motion is respected.

## Sandbox note
This build environment had no npm registry access. React, esbuild and Playwright came from preinstalled copies, and `@types/react` was unavailable, so `npm run typecheck:sandbox` uses a minimal shim (`sandbox/react-shim.d.ts`). On a normal machine, `npm install` brings the real types and `npm run typecheck` uses them. Run it once; the shim is looser than the real React types.
