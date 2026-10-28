// Quick single-config check: npx tsx bench/sendrate/one.ts <seed> <intervalMs...>
import { prepare, simulate } from './sim.ts';
const seed = Number(process.argv[2]);
const p = await prepare(seed);
for (const I of process.argv.slice(3).map(Number)) {
  const r = await simulate(p, { intervalMs: I, maxFps: 12, deviceFactor: 1, seed });
  console.log(`SIM seed ${seed} ${I} ms: file timing ${r.fileElapsedMs === null ? "—" : (r.fileElapsedMs / 1000).toFixed(1) + " s"}, ${r.goodputBps ? "" : ""}first pass ${(r.firstPassCoverage * 100).toFixed(0)}%, done ${r.completeMs === null ? '—' : (r.completeMs / 1000).toFixed(1) + ' s'} (${r.passesNeeded?.toFixed(2) ?? '—'} passes)`);
}
