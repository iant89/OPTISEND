# Vendored: zxing-wasm (reader build, unmodified)

- Upstream: https://github.com/Sec-ant/zxing-wasm, npm `zxing-wasm@3.1.5` (MIT, © Ze-Zheng Wu; `LICENSE`).
- It is ZXing-C++ compiled to WebAssembly: https://github.com/zxing-cpp/zxing-cpp at commit `2ecec3f5be0ee803f6e14a5a2c7028c0cfe525b4` (Apache License 2.0; `LICENSE.zxing-cpp`).
- Files, copied unchanged from the npm package:

  | Here | Package path | SHA-256 |
  |---|---|---|
  | `es/reader/index.js` | `dist/es/reader/index.js` | `3c364d8477404a513d7c0629b1cf9e63ae11e01f9746146d3574f8b10a122320` |
  | `es/share.js` | `dist/es/share.js` | `68b09047a19c17ba74c0bf7e0a4341e77d46b36ae1cae4bdcca31d0c6757f3f2` |
  | `zxing_reader.wasm` | `dist/reader/zxing_reader.wasm` | `aecc1876de036c62c8419f67a5e1a16b1698a325bcd190aa84810d516e263931` |

  The `.wasm` hash equals the library's own `ZXING_WASM_SHA256`, which the tests check.
- `es/reader/index.d.ts` is OptiSend's: minimal types for what it uses.
- Reviewed 2026-10-28: no `eval` or `new Function`. The only network access is `fetch` of the `.wasm` file. By default that comes from the jsDelivr CDN; OptiSend always overrides `locateFile` (browser: `dist/assets/zxing_reader.wasm`, copied there by `scripts/build.mjs`) or passes `wasmBinary` (Node tests), so the app never contacts the CDN.

To update: `npm pack zxing-wasm@<version>`, copy the three files, refresh the hashes here, and run `npm test` and `npm run test:e2e`.
