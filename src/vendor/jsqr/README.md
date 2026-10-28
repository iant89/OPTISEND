# Vendored: jsQR (modified)

- Upstream: https://github.com/cozmo/jsQR (Apache License 2.0, © Cosmo Wolfe)
- `jsQR.cjs`: the library's unminified UMD build (`dist/jsQR.js`), renamed to `.cjs` so ESM tooling treats it as CommonJS. The project owner supplied it because the build sandbox has no npm access.
- Pristine upstream copy: `tests/fixtures/jsQR.upstream.cjs`, SHA-256 `3325b0888fa4745c4e6940897d8c4f426fbaae76901fcbfe1871a04e90a51655`. The SHA is checked by the tests.
- Reviewed 2026-10-28: no network, `eval`/`Function`, DOM or storage access.

## OptiSend modifications (performance only)
Each change is marked `[OptiSend` in the source and listed in the notice at the top of `jsQR.cjs`:

| Change | Why |
|---|---|
| `binarize`: row-major loops, direct typed-array access, edge behaviour preserved | 31% of time; was column-major with a method call per pixel |
| `locate` row scan: no per-pixel closure, no per-transition arrays | ~29% of time |
| `countBlackWhiteRun*`: no point objects, inlined bounds checks | ~16% of time + garbage collection |
| New `jsQR.luminance(luma, w, h, opts)` | OptiSend already produces a smoothed grey plane; skips RGBA→grey |

**Equivalence:** `tests/jsqr-vendored.test.ts` compares the modified build with upstream: 96 comparisons (55 decoded codes) across code sizes, odd image dimensions, shear + noise, inverted codes, clutter, and all four inversion modes. Data, bytes, version and every corner/finder coordinate must be identical. `jsQR()` even keeps upstream's crash on `inversionAttempts: "onlyInvert"`; the new `luminance()` entry point fixes it.

**Speed** (Node 22, this sandbox): about 2.4× faster overall. In OptiSend's full decode step (smoothing + jsQR), simulated camera frames go from 69 → 28 ms (v15) and 86 → 36 ms (v25), with identical read rates. Benchmark: `npx tsx bench/make-corpus.ts`, then `node bench/run.cjs <file> [--luma]`.

Known upstream quirk, still present in `jsQR()`: it writes caller options into its shared defaults. This is harmless here, because OptiSend always passes the same options and uses `luminance()`.

To use the npm package instead: `npm install jsqr`, then change the import in `src/qr/decoders/jsqr-core.ts` (and replace `jsQR.luminance` with `jsQR`).
Apache-2.0 requires keeping this attribution, the upstream license, and these change notices with redistributed copies.
