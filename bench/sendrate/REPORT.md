# Send-rate benchmark (simulated)

Transfer: 40 data codes (11.0 KB, Conservative v15-M text-safe), 1280×720 30 fps camera, 20 ms rolling shutter, 12 ms exposure, σ5 noise. Seeds = camera poses (seed 2 is an awkward keystoned angle). ✗ = not verified within 5 passes.

### App today (fixed masks), 12 scans/s cap, this machine

| Per code | Codes/s | First-pass capture (avg) | Time to verified: seed 1 / seed 2 / seed 3 | Passes (avg, completed) | Goodput (avg, completed) | Decode ms |
|---|---|---|---|---|---|---|
| 1000 ms | 1.0 | 95% | 41.2s / ✗ / 61.1s | 1.22 | 229 B/s | 22 |
| 750 ms | 1.3 | 94% | 30.8s / ✗ / 45.9s | 1.22 | 305 B/s | 21 |
| 500 ms | 2.0 | 94% | 25.0s / ✗ / 30.6s | 1.32 | 409 B/s | 21 |
| 400 ms | 2.5 | 93% | 20.0s / ✗ / 24.5s | 1.33 | 511 B/s | 20 |
| 300 ms | 3.3 | 94% | 15.0s / ✗ / 12.4s | 1.09 | 828 B/s | 22 |
| 250 ms | 4.0 | 89% | 13.8s / ✗ / 15.3s | 1.39 | 775 B/s | 21 |
| 200 ms | 5.0 | 91% | 10.0s / ✗ / 16.2s | 1.56 | 908 B/s | 22 |
| 150 ms | 6.7 | 88% | 9.9s / ✗ / 18.4s | 2.25 | 873 B/s | 21 |
| 100 ms | 10.0 | 83% | 17.6s / ✗ / ✗ | 4.20 | 638 B/s | 21 |

### App today, 12 scans/s cap, 3× slower device

| Per code | Codes/s | First-pass capture (avg) | Time to verified: seed 1 / seed 2 / seed 3 | Passes (avg, completed) | Goodput (avg, completed) | Decode ms |
|---|---|---|---|---|---|---|
| 1000 ms | 1.0 | 95% | 50.1s / ✗ / 61.2s | 1.32 | 205 B/s | 62 |
| 750 ms | 1.3 | 95% | 37.7s / ✗ / 45.9s | 1.33 | 272 B/s | 65 |
| 500 ms | 2.0 | 93% | 25.3s / ✗ / 30.6s | 1.33 | 407 B/s | 67 |
| 400 ms | 2.5 | 93% | 20.2s / ✗ / 24.5s | 1.33 | 509 B/s | 63 |
| 300 ms | 3.3 | 95% | 12.4s / ✗ / 18.4s | 1.22 | 760 B/s | 66 |
| 250 ms | 4.0 | 92% | 12.6s / ✗ / 20.1s | 1.56 | 725 B/s | 63 |
| 200 ms | 5.0 | 92% | 10.1s / ✗ / 12.4s | 1.34 | 1012 B/s | 63 |
| 150 ms | 6.7 | 88% | 8.4s / ✗ / 11.6s | 1.58 | 1159 B/s | 67 |
| 100 ms | 10.0 | 87% | 5.1s / ✗ / 6.2s | 1.35 | 2007 B/s | 61 |

### Uncapped scanning (30/s), this machine

| Per code | Codes/s | First-pass capture (avg) | Time to verified: seed 1 / seed 2 / seed 3 | Passes (avg, completed) | Goodput (avg, completed) | Decode ms |
|---|---|---|---|---|---|---|
| 1000 ms | 1.0 | 96% | 41.1s / ✗ / 41.0s | 0.98 | 274 B/s | 21 |
| 750 ms | 1.3 | 97% | 30.8s / ✗ / 30.8s | 0.98 | 365 B/s | 22 |
| 500 ms | 2.0 | 95% | 25.1s / ✗ / 30.5s | 1.32 | 409 B/s | 22 |
| 400 ms | 2.5 | 96% | 20.1s / ✗ / 16.4s | 1.09 | 623 B/s | 21 |
| 300 ms | 3.3 | 94% | 15.1s / ✗ / 12.4s | 1.09 | 828 B/s | 21 |
| 250 ms | 4.0 | 96% | 10.3s / ✗ / 10.3s | 0.98 | 1094 B/s | 21 |
| 200 ms | 5.0 | 93% | 10.0s / ✗ / 11.5s | 1.28 | 1051 B/s | 21 |
| 150 ms | 6.7 | 91% | 7.5s / ✗ / 10.6s | 1.44 | 1279 B/s | 22 |
| 100 ms | 10.0 | 92% | 5.5s / ✗ / 7.5s | 1.55 | 1773 B/s | 21 |

### Uncapped scanning (30/s), 3× slower device

| Per code | Codes/s | First-pass capture (avg) | Time to verified: seed 1 / seed 2 / seed 3 | Passes (avg, completed) | Goodput (avg, completed) | Decode ms |
|---|---|---|---|---|---|---|
| 1000 ms | 1.0 | 95% | 50.1s / ✗ / 41.2s | 1.09 | 249 B/s | 63 |
| 750 ms | 1.3 | 94% | 30.9s / ✗ / 45.9s | 1.22 | 305 B/s | 66 |
| 500 ms | 2.0 | 94% | 25.2s / ✗ / 20.6s | 1.09 | 497 B/s | 67 |
| 400 ms | 2.5 | 93% | 20.2s / ✗ / 24.5s | 1.33 | 509 B/s | 67 |
| 300 ms | 3.3 | 93% | 12.4s / ✗ / 24.1s | 1.45 | 687 B/s | 66 |
| 250 ms | 4.0 | 93% | 13.9s / ✗ / 15.4s | 1.39 | 771 B/s | 65 |
| 200 ms | 5.0 | 92% | 10.1s / ✗ / 12.4s | 1.34 | 1013 B/s | 69 |
| 150 ms | 6.7 | 88% | 10.5s / ✗ / 11.6s | 1.75 | 1025 B/s | 68 |
| 100 ms | 10.0 | 81% | 8.3s / ✗ / 8.2s | 1.97 | 1364 B/s | 68 |

### Masks rotate each pass, 12 scans/s, this machine

| Per code | Codes/s | First-pass capture (avg) | Time to verified: seed 1 / seed 2 / seed 3 | Passes (avg, completed) | Goodput (avg, completed) | Decode ms |
|---|---|---|---|---|---|---|
| 1000 ms | 1.0 | 96% | 41.0s / 72.1s / 61.1s | 1.38 | 205 B/s | 22 |
| 750 ms | 1.3 | 94% | 30.8s / 60.8s / 45.9s | 1.46 | 265 B/s | 21 |
| 500 ms | 2.0 | 94% | 25.0s / 40.6s / 30.6s | 1.53 | 365 B/s | 22 |
| 400 ms | 2.5 | 93% | 20.0s / 32.6s / 24.5s | 1.53 | 456 B/s | 21 |
| 300 ms | 3.3 | 94% | 15.0s / 24.4s / 12.4s | 1.37 | 706 B/s | 22 |
| 250 ms | 4.0 | 89% | 13.8s / 30.8s / 15.3s | 1.90 | 638 B/s | 21 |
| 200 ms | 5.0 | 91% | 10.0s / 16.4s / 16.1s | 1.69 | 836 B/s | 23 |
| 150 ms | 6.7 | 88% | 9.9s / 18.6s / 12.1s | 2.15 | 890 B/s | 22 |
| 100 ms | 10.0 | 83% | 5.0s / 8.1s / ✗ | 1.57 | 1809 B/s | 22 |

### Masks rotate each pass, 12 scans/s, 3× slower device

| Per code | Codes/s | First-pass capture (avg) | Time to verified: seed 1 / seed 2 / seed 3 | Passes (avg, completed) | Goodput (avg, completed) | Decode ms |
|---|---|---|---|---|---|---|
| 1000 ms | 1.0 | 95% | 50.1s / 72.1s / 61.1s | 1.46 | 188 B/s | 63 |
| 750 ms | 1.3 | 95% | 37.7s / 61.1s / 30.8s | 1.37 | 283 B/s | 68 |
| 500 ms | 2.0 | 94% | 25.2s / 40.6s / 28.6s | 1.50 | 373 B/s | 62 |
| 400 ms | 2.5 | 94% | 20.1s / 32.6s / 24.5s | 1.53 | 455 B/s | 65 |
| 300 ms | 3.3 | 95% | 12.4s / 24.4s / 18.5s | 1.46 | 661 B/s | 69 |
| 250 ms | 4.0 | 91% | 13.9s / 18.1s / 20.1s | 1.65 | 665 B/s | 65 |
| 200 ms | 5.0 | 91% | 10.2s / 16.4s / 12.4s | 1.55 | 900 B/s | 70 |
| 150 ms | 6.7 | 86% | 22.6s / 18.5s / 12.1s | 2.82 | 678 B/s | 66 |
| 100 ms | 10.0 | 83% | 5.1s / 12.4s / 11.3s | 2.28 | 1370 B/s | 64 |

## Validation against the real app

`bench/sendrate/validate.ts` writes the simulator's camera to a looping Y4M video (three passes, three hand poses). It feeds that to Chromium as the webcam of the **built receiver app**, then reads the app's own "Received in …" figure.

| Per code | Simulator: file time (first chunk → verified) | Real app | 
|---|---|---|
| 500 ms | 24.0 s | 24 s |
| 200 ms | 9.6 s | 10 s |
| 150 ms | 9.6 s | 10 s |

The real app scanned at 10–10.5 scans/s with about 30 ms per decode (simulator: about 21 ms in Node).

## Findings

1. **About 5 codes/s (200 ms) is the practical sweet spot.**
   - It's roughly 3× faster than today's 750 ms default for the same transfer: about 10–16 s instead of 31–46 s.
   - It holds up across both device speeds and both scan caps: about 91% first-pass capture, completing in about 1.3–1.6 passes.
2. **Going faster still shortens the total time, but reliability drops.**
   - At 150 ms the results vary more from run to run.
   - At 100 ms, a 30 fps camera gets about 3 frames per code, and about 1 in 3 of those is torn by the rolling shutter.
   - With the 12 scans/s cap the receiver tries only about once per code, and the scan timing can lock onto the code changes (aliasing). Some 100 ms runs never completed.
3. **Speed is not the biggest reliability risk; camera angle is.**
   - At an awkward keystoned angle (seed 2), a few specific codes were never readable by jsQR. The file never completed at *any* speed, even 1 s per code.
   - Rotating the QR mask each pass fixed that in every configuration: same content, different module pattern.
4. The receiver's ceiling is the camera frame rate and the scan cap, not jsQR's speed. On this machine a decode takes about 21 ms; even a phone 3× slower (about 65 ms) keeps up at 200 ms per code.

## Caveats
Simulated camera: 720p, 30 fps, mild hand jitter, no autofocus hunting or motion blur. Real phones capture at 1080p, which helps, and some at 60 fps, which helps more. Real-device testing is still required before changing defaults.

## After tuning (implemented)

These are now in the app:
- 200 ms default interval.
- QR mask rotated every pass. Pass 1 uses the automatic mask; each later pass is +3 mod 8, so 8 passes cover all masks.
- ±25% random jitter on the scanner's gap between scans.

Simulator results: 12 scans/s cap, three camera poses (seed 2 is the awkward angle).

| Per code | Before: seed 1 / 2 / 3 (this machine) | After: seed 1 / 2 / 3 (this machine) | After, 3× slower device |
|---|---|---|---|
| 300 ms | 15.0 s / ✗ / 12.4 s | 15.1 s / 24.6 s / 18.4 s | 12.4 s / 37.0 s / 18.4 s |
| 250 ms | 13.8 s / ✗ / 15.3 s | 12.6 s / 20.4 s / 20.1 s | 10.4 s / 20.4 s / 20.1 s |
| **200 ms** | **10.0 s / ✗ / 16.2 s** | **11.2 s / 16.3 s / 12.3 s** | **11.2 s / 16.3 s / 12.3 s** |
| 150 ms | 9.9 s / ✗ / 18.4 s | 8.4 s / 12.2 s / 12.1 s | 7.6 s / 18.6 s / 12.1 s |
| 100 ms | 17.6 s / ✗ / ✗ | 8.3 s / 12.2 s / 6.7 s | 8.3 s / 12.4 s / 11.2 s |

- **Every run now completes: 30 of 30, against 19 of 30 before.** At the awkward angle the file used to never finish at any speed; now it finishes in 12–37 s.
- **Jitter removed the 100 ms aliasing.** Seed 1 went from 4.2 passes (17.6 s) to 2 passes (8.3 s).
- **Individual times move by ±1–5 s from run to run,** because jitter and mask choice change which frames land. The worst case is what improved.

Real app check with the new code (Chromium fake webcam, awkward angle, 200 ms per code): **received in 16 s** (simulator: 16.3 s). Before the change this configuration never completed.

## Torn frames mostly still decode

Measured with `tornDecoded` in `sim.ts` (rotating masks, scan jitter, 12 scans/s cap, this machine). A frame counts as torn if any row was exposed across a code switch.

| Per code | Seed 1: torn / still decoded (of all scans) | Seed 3: torn / still decoded (of all scans) |
|---|---|---|
| 200 ms | 28 / 27 (of 112) | 25 / 24 (of 124) |
| 150 ms | 20 / 14 (of 84) | 30 / 21 (of 122) |
| 100 ms | 43 / 40 (of 83) | 27 / 24 (of 67) |

The tear is usually a soft blend over part of the code, which QR error correction absorbs, and the frame decodes as one of the two codes. At the 200 ms default, torn frames that fail cost about 1% of decode attempts, and about 7% at 150 ms. Rejecting torn frames before decoding (for example with a sender border whose colour alternates per code) would discard far more good decodes than it saves.
