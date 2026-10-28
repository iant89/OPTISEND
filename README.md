# OptiSend

Offline file transfer between devices using only a screen and a camera. No uploads, no accounts, no network during transfer.

| Phase | Status |
|-------|--------|
| 1 · Protocol foundation | ✅ done |
| 2 · Sender | ✅ done |
| 3 · Receiver (camera) | ✅ done |
| 4 · Storage & recovery | next (IndexedDB persistence, resume after reload) |

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173 (esbuild, rebuilds on change)
npm run build        # static site in dist/ (deploy anywhere; camera needs HTTPS in Phase 3)
npm test             # 116 unit tests (node:test via tsx)
npm run test:e2e     # 8 browser tests (needs `npm run build`, Playwright Chromium, python3 + opencv)
npm run typecheck
```

Runtime dependencies: `react`, `react-dom`, and jsQR, vendored in `src/vendor/jsqr/` (Apache-2.0). It has been performance-modified: about 2.4× faster and proven bit-identical to upstream (see the README there). The QR encoder, SHA-256 and the protocol are in-house.

The camera only works on a secure page (https:// or localhost). To test on a phone, serve `dist/` over HTTPS.

## Phase 2 — Sender

- **Send screen:** native picker (multiple files), drag-and-drop on desktop, per-file remove / clear all, sizes and totals. Hashing runs in a Web Worker and is cached per file, so changing settings never re-hashes.
- **Settings:** density presets (Conservative v15-M · Balanced v25-M · High throughput v40-L) or custom version / ECC / payload limit; 500 ms–1.5 s per code; 1, 2, 3 or 5 passes, or loop until stopped; sequential or interleaved files; manifest repeat interval; hold manifest frames 2×; text-safe vs binary transport. Settings persist in localStorage.
- **Estimate:** QR codes per pass, bytes per code, pass time, total time and best-case rate. These are computed before hashing, and a test checks they match the real plan frame for frame. A preview shows the first code.
- **Transmission view:** full-screen where supported, with the screen kept awake. The QR is drawn at whole device pixels per module, with the quiet zone and no blur or stretching. It shows file and chunk position, pass number and a segmented per-pass bar. Controls: pause/resume, previous/next, live interval change, Stop, Finish and Repeat pass. Keyboard: Space toggles pause, ←/→ step. It pauses automatically if the page is hidden, since a hidden page shows no code.
- **Honest completion:** the summary says what was displayed and states plainly that only the receiver can confirm a file is complete (spec §8.3).
- **Scheduler:** drift-free monotonic timing. If the page falls far behind it re-anchors rather than flashing a burst of frames, and it counts those resyncs.

## Phase 3 — Receiver

- **Camera:** the rear camera is preferred at 1080p, with continuous focus where supported. Errors map to clear help: permission denied, no camera, camera busy, not a secure page, not supported. Each has a working Try again. Tracks are stopped when leaving the screen.
- **Decoder plug-ins** (`src/qr/decoders/`): one `FrameDecoder` interface with a `DecoderChain`.
  - *Automatic*: the built-in `BarcodeDetector` first (fast, text only), then jsQR in a worker (raw bytes, so binary mode works everywhere).
  - *Compare all*: runs every decoder on every frame and records reads, accepts, rescues and timings, shown under Scanner settings & diagnostics. Our own decoder will plug in here later (see `status/decisions.md` in the project).
- **Scanning loop:** uses `requestVideoFrameCallback`, falling back to rAF. At most 12 scans per second, never more than one decode in flight. It crops to the guide square and downscales to a size based on the QR version. It alternates with the full frame until a code is found, so a phone held too close still scans. Before jsQR it applies a 3×3 luminance smoothing pass, which in simulation raised v15 decoding from 15/24 to 21/24 frames and made it faster. Scanning pauses while the page is hidden.
- **Receive screen:** live preview with a scan guide, and a brief green pulse on each new chunk (none for duplicates). Each file gets a segmented bar, byte-based %, chunk counts and a status badge: Receiving, Verifying, ✓ Verified, or ✕ Failed with "Discard and receive again". It also shows valid, missing, duplicate and invalid counts, Pause/Resume and Stop. Screen-reader announcements and optional vibration fire when a file verifies.
- **Saving:** Save (object URL + download) and Share… (Web Share with files, which is the best path on iOS). MIME types are allow-listed; HTML and SVG always download as octet-stream. File names are sanitised.
- **App-level engine:** leaving the receive screen keeps partial and finished transfers. The home screen lists received files (with Save) and incomplete ones (with Resume). For now this lasts only while the page is open; Phase 4 adds IndexedDB.

### Measured readability (simulated 1080p phone camera, jsQR)

| Preset | Frames decoded | Notes |
|---|---|---|
| Conservative v15-M | 21/24 (88%) | each code gets about 9 scan attempts, so effectively every code is caught |
| Balanced v25-M | 9/24 (38%) | works with a steady, close camera, but slower in practice |
| High throughput v40-L | 0/24 | marked experimental in the UI; this is the in-house decoder's target |

The full browser loop (`e2e/receiver.test.ts`) screenshots the real sender app during a transfer, "films" it with a simulated hand-held camera, and plays that to a second Chromium as its webcam. The receiver app decoded 81 of 85 frames (95%) and verified and saved both files byte-for-byte in about 8 seconds of scanning.

### Default transport is text-safe (Base45)
The browser e2e test showed that desktop QR decoders return byte-mode content as *text* and cut it off at the first zero byte, so every binary frame was rejected (safely, by CRC/length checks). `BarcodeDetector.rawValue` and phone camera apps are text-only too. Text-safe mode works with any scanner and costs about 3% capacity. Binary mode stays available for receivers that read raw bytes.

## Layout

| Path | Purpose |
|------|---------|
| `src/protocol/` | Wire format, sender packetizer, receiver engine (Phase 1) |
| `src/qr/encoder.ts` | QR Model 2 encoder: byte/alphanumeric, v1–40, L/M/Q/H, automatic masking |
| `src/qr/render.ts` | Crisp canvas rendering and layout math |
| `src/features/sender/` | Scheduler, settings/estimates, frame pipeline, Send and Transmit screens |
| `src/workers/` | Hash, QR-generation and scan (jsQR) workers, with automatic main-thread fallback |
| `src/qr/decoders/` | Decoder plug-in interface, chain with per-decoder stats, native + jsQR plug-ins |
| `src/camera/` | Camera open/close and error classification |
| `src/features/receiver/` | Scanner loop, scan-region geometry, Receive screen |
| `src/features/files/` | Save / Share for verified files |
| `src/vendor/jsqr/` | Vendored jsQR (Apache-2.0) + types |
| `src/components/` | `QrCanvas`, `SegmentedBar` (scales to tens of thousands of segments) |
| `e2e/` | Playwright tests and a pixel-exact QR reader used to verify binary frames |
| `docs/PROTOCOL.md` | Normative wire format |

## How it was verified

- **QR encoder:** module-for-module identical to OpenCV's encoder in 312 of 320 version × ECC × mode combinations. The other 8 are cases where OpenCV's own output doesn't decode; ours does. Auto-masked output decodes with two independent decoders, and RS, BCH and alignment values match ISO 18004 reference values.
- **Browser end to end:** the built app runs in Chromium. Every code it draws is captured from the canvas, decoded by OpenCV/WeChat, or by a pixel-exact reader that checks every Reed–Solomon block, and fed to the receiver engine. Four files rebuild byte-for-byte and verify: binary data, two different files both named `notes.txt`, and an empty file.
- **Accessibility checks:** every control is at least 44 px, all buttons are named, there's no horizontal scroll at 320 px, focus is visible, progress is announced through ARIA, and reduced motion is respected.

## Sandbox note
This build environment had no npm registry access. React, esbuild and Playwright came from preinstalled copies, and `@types/react` was unavailable, so `npm run typecheck:sandbox` uses a minimal shim (`sandbox/react-shim.d.ts`). On a normal machine, `npm install` brings the real types and `npm run typecheck` uses them. Run it once; the shim is looser than the real React types.
