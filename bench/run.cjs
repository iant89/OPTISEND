// node bench/run.cjs <jsQR-file>   (upstream: tests/fixtures/jsQR.upstream.cjs, modified: src/vendor/jsqr/jsQR.cjs) [--json out.json] [--reps N]
// Decodes every corpus frame (inversionAttempts: dontInvert, as OptiSend does),
// reports per-category timings and writes exact results for equivalence checks.
const fs = require('fs');
const path = require('path');
const lib = require(path.resolve(process.argv[2]));
const base = lib.default || lib;
const jsQR = process.argv.includes('--luma') ? base.luminance : base;
const args = process.argv.slice(3);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const luma = args.includes('--luma');
const reps = args.includes('--reps') ? Number(args[args.indexOf('--reps') + 1]) : 3;
const buf = fs.readFileSync(path.join(__dirname, 'corpus.bin'));
let o = 0; const n = buf.readUInt32LE(o); o += 4;
const frames = [];
for (let i = 0; i < n; i++) {
  const tl = buf.readUInt32LE(o), w = buf.readUInt32LE(o + 4), h = buf.readUInt32LE(o + 8); o += 12;
  const tag = buf.toString('utf8', o, o + tl); o += tl;
  const data = new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + w * h * 4)); o += w * h * 4;
  let input = data;
  if (luma) { input = new Uint8ClampedArray(w * h); for (let k = 0; k < w * h; k++) input[k] = data[k * 4]; }
  frames.push({ tag, w, h, data: input });
}
// Warm-up so the JIT has compiled the hot paths.
for (const f of frames.slice(0, 6)) jsQR(f.data, f.w, f.h, { inversionAttempts: 'dontInvert' });
const results = {}; const times = {};
for (const f of frames) {
  let best = Infinity, r = null;
  for (let k = 0; k < reps; k++) { const t = process.hrtime.bigint(); r = jsQR(f.data, f.w, f.h, { inversionAttempts: 'dontInvert' }); best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6); }
  results[f.tag] = r ? { bytes: Buffer.from(r.binaryData).toString('hex'), version: r.version, loc: Object.fromEntries(Object.entries(r.location).map(([k, p]) => [k, p ? [+p.x.toFixed(3), +p.y.toFixed(3)] : null])) } : null;
  const cat = f.tag.replace(/-\d+$/, '');
  (times[cat] ||= []).push(best);
}
for (const [cat, ts] of Object.entries(times)) {
  const decoded = Object.entries(results).filter(([t, r]) => t.startsWith(cat + '-') && r).length;
  console.log(`${cat.padEnd(12)} n=${String(ts.length).padStart(2)} decoded=${String(decoded).padStart(2)}  mean ${(ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(1).padStart(6)} ms  max ${Math.max(...ts).toFixed(1).padStart(6)} ms`);
}
const all = Object.values(times).flat();
console.log(`ALL          n=${all.length} mean ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(1)} ms`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results));
