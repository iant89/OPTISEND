# OptiSend

Offline file transfer between devices using only a screen and a camera. No uploads, no accounts, no network during transfer.

| Phase | Status |
|-------|--------|
| 1 · Protocol foundation | ✅ done |
| 2 · Sender | ✅ done |
| 3 · Receiver (camera) | next |
| 4 · Storage & recovery | — |

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173 (esbuild, rebuilds on change)
npm run build        # static site in dist/ (deploy anywhere; camera needs HTTPS in Phase 3)
npm test             # 100 unit tests (node:test via tsx)
npm run test:e2e     # 4 browser tests (needs `npm run build`, Playwright Chromium, python3 + opencv)
npm run typecheck
```

Runtime dependencies are only `react` and `react-dom`. The QR encoder, SHA-256 and the protocol are all in-house and dependency-free.

## Phase 2 — Sender

- **Send screen:** native picker (multiple files), drag-and-drop on desktop, per-file remove / clear all, sizes and totals. Hashing runs in a Web Worker and is cached per file, so changing settings never re-hashes.
- **Settings:** density presets (Conservative v15-M · Balanced v25-M · High throughput v40-L) or custom version / ECC / payload limit; 500 ms–1.5 s per code; 1, 2, 3 or 5 passes, or loop until stopped; sequential or interleaved files; manifest repeat interval; hold manifest frames 2×; text-safe vs binary transport. Settings persist in localStorage.
- **Estimate:** QR codes per pass, bytes per code, pass time, total time and best-case rate. These are computed before hashing, and a test checks they match the real plan frame for frame. A preview shows the first code.
- **Transmission view:** full-screen where supported, with the screen kept awake. The QR is drawn at whole device pixels per module, with the quiet zone and no blur or stretching. It shows file and chunk position, pass number and a segmented per-pass bar. Controls: pause/resume, previous/next, live interval change, Stop, Finish and Repeat pass. Keyboard: Space toggles pause, ←/→ step. It pauses automatically if the page is hidden, since a hidden page shows no code.
- **Honest completion:** the summary says what was displayed and states plainly that only the receiver can confirm a file is complete (spec §8.3).
- **Scheduler:** drift-free monotonic timing. If the page falls far behind it re-anchors rather than flashing a burst of frames, and it counts those resyncs.

### Default transport is text-safe (Base45)
The browser e2e test showed that desktop QR decoders return byte-mode content as *text* and cut it off at the first zero byte, so every binary frame was rejected (safely, by CRC/length checks). `BarcodeDetector.rawValue` and phone camera apps are text-only too. Text-safe mode works with any scanner and costs about 3% capacity. Binary mode stays available for receivers that read raw bytes.

## Layout

| Path | Purpose |
|------|---------|
| `src/protocol/` | Wire format, sender packetizer, receiver engine (Phase 1) |
| `src/qr/encoder.ts` | QR Model 2 encoder: byte/alphanumeric, v1–40, L/M/Q/H, automatic masking |
| `src/qr/render.ts` | Crisp canvas rendering and layout math |
| `src/features/sender/` | Scheduler, settings/estimates, frame pipeline, Send and Transmit screens |
| `src/workers/` | Hash and QR workers, with automatic main-thread fallback |
| `src/components/` | `QrCanvas`, `SegmentedBar` (scales to tens of thousands of segments) |
| `e2e/` | Playwright tests and a pixel-exact QR reader used to verify binary frames |
| `docs/PROTOCOL.md` | Normative wire format |

## How it was verified

- **QR encoder:** module-for-module identical to OpenCV's encoder in 312 of 320 version × ECC × mode combinations. The other 8 are cases where OpenCV's own output doesn't decode; ours does. Auto-masked output decodes with two independent decoders, and RS, BCH and alignment values match ISO 18004 reference values.
- **Browser end to end:** the built app runs in Chromium. Every code it draws is captured from the canvas, decoded by OpenCV/WeChat, or by a pixel-exact reader that checks every Reed–Solomon block, and fed to the receiver engine. Four files rebuild byte-for-byte and verify: binary data, two different files both named `notes.txt`, and an empty file.
- **Accessibility checks:** every control is at least 44 px, all buttons are named, there's no horizontal scroll at 320 px, focus is visible, progress is announced through ARIA, and reduced motion is respected.

## Sandbox note
This build environment had no npm registry access. React, esbuild and Playwright came from preinstalled copies, and `@types/react` was unavailable, so `npm run typecheck:sandbox` uses a minimal shim (`sandbox/react-shim.d.ts`). On a normal machine, `npm install` brings the real types and `npm run typecheck` uses them. Run it once; the shim is looser than the real React types.
