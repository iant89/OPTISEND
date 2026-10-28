// Build: node scripts/build.mjs        → dist/
// Dev:   node scripts/build.mjs --serve → http://localhost:5173 (rebuilds on change)
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const serve = process.argv.includes('--serve');
const outdir = 'dist/assets';

await rm('dist', { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp('public', 'dist', { recursive: true });
// ZXing-C++ WebAssembly, loaded at runtime next to the bundles (never from a CDN).
await cp('src/vendor/zxing-wasm/zxing_reader.wasm', `${outdir}/zxing_reader.wasm`);

const options = {
  entryPoints: {
    main: 'src/app/main.tsx',
    'qr.worker': 'src/workers/qr.worker.ts',
    'hash.worker': 'src/workers/hash.worker.ts',
    'scan.worker': 'src/workers/scan.worker.ts',
    'zxing.worker': 'src/workers/zxing.worker.ts',
    'colour.worker': 'src/workers/colour.worker.ts',
    styles: 'src/app/styles.css',
  },
  outdir,
  bundle: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: ['es2022', 'safari16', 'chrome110', 'firefox115'],
  jsx: 'automatic',
  minify: !serve,
  sourcemap: serve ? 'inline' : 'linked',
  define: { 'process.env.NODE_ENV': JSON.stringify(serve ? 'development' : 'production') },
  logLevel: 'info',
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: 'dist', port: 5173 });
  console.log(`OptiSend dev server: http://localhost:${port}`);
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  const sizes = Object.entries(result.metafile.outputs)
    .filter(([f]) => !f.endsWith('.map'))
    .map(([f, o]) => `${f.padEnd(32)} ${(o.bytes / 1024).toFixed(1)} KB`);
  console.log(sizes.join('\n'));
}
