// Does changing the QR mask rescue codes that are unreadable at a given camera pose?
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from './sim.ts';
import { encodeQr } from '../../src/qr/encoder.ts';
import { frameForQr } from '../../src/protocol/transport.ts';
import { decodeWithJsQr } from '../../src/qr/decoders/jsqr-core.ts';
import { acceptHit } from '../../src/features/receiver/scanner.ts';
import { scanRegion } from '../../src/features/receiver/region.ts';
import { DEFAULT_SETTINGS, resolveQrConfig } from '../../src/features/sender/settings.ts';
const seed = Number(process.argv[2]);
const p = await prepare(seed);
const cfg = resolveQrConfig(DEFAULT_SETTINGS);
const r = scanRegion(p.w, p.h, 1, 2000);
const read = (view: Uint8Array) => {
  const rgba = new Uint8ClampedArray(r.sSize * r.sSize * 4);
  for (let y = 0; y < r.sSize; y++) for (let x = 0; x < r.sSize; x++) { const g = view[(r.sy + y) * p.w + r.sx + x]!; const k = (y * r.sSize + x) * 4; rgba[k] = rgba[k + 1] = rgba[k + 2] = g; rgba[k + 3] = 255; }
  const h = decodeWithJsQr({ data: rgba, width: r.sSize, height: r.sSize });
  return !!(h && acceptHit(h));
};
let totalCodes = 0, stuckAllMasksDefault = 0, rescued = 0;
const perMask = new Array(8).fill(0);
for (let i = 0; i < p.packets.length; i++) {
  const codes = [];
  for (let m = 0; m < 8; m++) {
    const q = encodeQr(frameForQr(p.packets[i]!, cfg.transport), { ecc: cfg.ecc, minVersion: cfg.version, mask: m });
    codes.push({ size: q.size, bits: Array.from(q.modules, (v) => (v ? '1' : '0')).join('') });
  }
  const dir = mkdtempSync(join(tmpdir(), 'mask-'));
  const out = join(dir, 'v.bin');
  const res = spawnSync('python3', ['bench/sendrate/render_views.py'], { input: JSON.stringify({ w: p.w, h: p.h, seed, variants: 1, out, codes }), encoding: 'utf8', maxBuffer: 1 << 26 });
  if (res.status !== 0) throw new Error(res.stderr);
  const raw = readFileSync(out);
  const ok = codes.map((_, m) => read(new Uint8Array(raw.buffer, raw.byteOffset + m * p.w * p.h, p.w * p.h)));
  ok.forEach((v, m) => { if (v) perMask[m]++; });
  totalCodes++;
  const auto = encodeQr(frameForQr(p.packets[i]!, cfg.transport), { ecc: cfg.ecc, minVersion: cfg.version }).mask;
  if (!ok[auto]) { stuckAllMasksDefault++; if (ok.some(Boolean)) rescued++; }
}
console.log(`seed ${seed}: ${totalCodes} codes; default mask unreadable for ${stuckAllMasksDefault}; another mask reads ${rescued} of those`);
console.log(`readable per mask: ${perMask.map((n, m) => `m${m}=${n}`).join(' ')}`);
