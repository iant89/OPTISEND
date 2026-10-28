// Summarise bench/sendrate/results-seed*.json into tables.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { SimResult } from './sim.ts';
const all: SimResult[] = readdirSync('bench/sendrate').filter((f) => /^results-seed\d+\.json$/.test(f)).flatMap((f) => JSON.parse(readFileSync(`bench/sendrate/${f}`, 'utf8')));
const intervals = [...new Set(all.map((r) => r.intervalMs))].sort((a, b) => b - a);
const seeds = [...new Set(all.map((r) => r.seed))].sort();
const sel = (m: string, f: number, c: number, i: number) => all.filter((r) => r.masks === m && r.deviceFactor === f && r.maxFps === c && r.intervalMs === i);
const s = (ms: number | null) => (ms === null ? '✗' : `${(ms / 1000).toFixed(1)}s`);
const lines: string[] = [];
const table = (title: string, m: 'fixed' | 'rotating', f: number, c: number) => {
  lines.push(`\n### ${title}\n`);
  lines.push(`| Per code | Codes/s | First-pass capture (avg) | Time to verified: ${seeds.map((x) => `seed ${x}`).join(' / ')} | Passes (avg, completed) | Goodput (avg, completed) | Decode ms |`);
  lines.push('|---|---|---|---|---|---|---|');
  for (const i of intervals) {
    const rs = sel(m, f, c, i).sort((a, b) => a.seed - b.seed);
    if (!rs.length) continue;
    const done = rs.filter((r) => r.completeMs !== null);
    const cov = rs.reduce((n, r) => n + r.firstPassCoverage, 0) / rs.length;
    const passes = done.length ? done.reduce((n, r) => n + r.passesNeeded!, 0) / done.length : null;
    const gp = done.length ? done.reduce((n, r) => n + r.goodputBps!, 0) / done.length : null;
    const dec = rs.reduce((n, r) => n + r.avgDecodeMs, 0) / rs.length;
    lines.push(`| ${i} ms | ${(1000 / i).toFixed(1)} | ${(cov * 100).toFixed(0)}% | ${rs.map((r) => s(r.completeMs)).join(' / ')} | ${passes === null ? '—' : passes.toFixed(2)} | ${gp === null ? '—' : gp.toFixed(0) + ' B/s'} | ${dec.toFixed(0)} |`);
  }
};
table('App today (fixed masks), 12 scans/s cap, this machine', 'fixed', 1, 12);
table('App today, 12 scans/s cap, 3× slower device', 'fixed', 3, 12);
table('Uncapped scanning (30/s), this machine', 'fixed', 1, 30);
table('Uncapped scanning (30/s), 3× slower device', 'fixed', 3, 30);
table('Masks rotate each pass, 12 scans/s, this machine', 'rotating', 1, 12);
table('Masks rotate each pass, 12 scans/s, 3× slower device', 'rotating', 3, 12);
const theo = all[0]!;
lines.unshift(`Transfer: ${theo.dataCodes} data codes (${((theo.theoreticalBps * theo.passMs) / 1000 / 1024).toFixed(1)} KB, Conservative v15-M text-safe), 1280×720 30 fps camera, 20 ms rolling shutter, 12 ms exposure, σ5 noise. Seeds = camera poses (seed 2 is an awkward keystoned angle). ✗ = not verified within 5 passes.`);
writeFileSync('bench/sendrate/REPORT.md', `# Send-rate benchmark (simulated)\n\n${lines.join('\n')}\n`);
console.log(lines.join('\n'));
