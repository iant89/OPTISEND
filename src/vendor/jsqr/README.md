# Vendored: jsQR

- Upstream: https://github.com/cozmo/jsQR (Apache License 2.0, © Cosmo Wolfe)
- File: `jsQR.cjs` (renamed from `dist/jsQR.js` so ESM tooling treats the UMD bundle as CommonJS) — the library's unminified UMD build (`dist/jsQR.js`), supplied by the project owner because the build sandbox has no npm access.
- SHA-256: `3325b0888fa4745c4e6940897d8c4f426fbaae76901fcbfe1871a04e90a51655`
- Reviewed 2026-10-28: no network, `eval`/`Function`, DOM or storage access; pure image → QR decoding.
- Known quirk: `jsQR()` writes caller options into its shared defaults object. Harmless here because OptiSend always passes the same options.

To switch to the npm package instead: `npm install jsqr` and change the import in `src/qr/decoders/jsqr-core.ts`.
Apache-2.0 requires keeping this attribution and the upstream license with redistributed copies.
