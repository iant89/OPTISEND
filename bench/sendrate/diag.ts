// Diagnose per-code readability for one seed's camera views (no noise, no tearing).
import { writeFileSync } from 'node:fs';
import { prepare } from './sim.ts';
import { decodeWithJsQr } from '../../src/qr/decoders/jsqr-core.ts';
import { acceptHit } from '../../src/features/receiver/scanner.ts';
import { scanRegion } from '../../src/features/receiver/region.ts';
const seed = Number(process.argv[2]);
const out = process.argv[3];
const p = await prepare(seed);
for (const frac of [0.85, 1]) {
  const r = scanRegion(p.w, p.h, frac, 2000);
  const fails: number[] = [];
  for (let v = 0; v < p.views.length; v++) {
    p.views[v]!.forEach((view, i) => {
      const rgba = new Uint8ClampedArray(r.sSize * r.sSize * 4);
      for (let y = 0; y < r.sSize; y++) for (let x = 0; x < r.sSize; x++) { const g = view[(r.sy + y) * p.w + r.sx + x]!; const k = (y * r.sSize + x) * 4; rgba[k] = rgba[k + 1] = rgba[k + 2] = g; rgba[k + 3] = 255; }
      const sm = decodeWithJsQr({ data: rgba, width: r.sSize, height: r.sSize });
      const raw = decodeWithJsQr({ data: rgba, width: r.sSize, height: r.sSize }, { smooth: false });
      if (!(sm && acceptHit(sm))) fails.push(v * 100 + i);
      if (frac === 1 && v === 0 && i < 3 && out) writeFileSync(`${out}/view${i}.pgm`, Buffer.concat([Buffer.from(`P5 ${p.w} ${p.h} 255\n`), Buffer.from(view)]));
      if (!(sm && acceptHit(sm)) && raw) console.log(`  v${v} code ${i}: smoothing broke it (raw decodes)`);
    });
  }
  console.log(`fraction ${frac}: ${fails.length} failing of ${p.views.length * p.views[0]!.length} → ${fails.slice(0, 20).join(',')}`);
}
