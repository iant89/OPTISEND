/**
 * Run the REAL receiver app (built dist/) in Chromium with the simulator's camera as its
 * webcam, and read back the app's own per-file timing. Compare with sim.ts for the
 * same seed and interval (fixed masks, 12 scans/s cap, device factor 1).
 * Usage: npx tsx bench/sendrate/validate.ts <seed> <intervalMs...>
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { serveDist } from '../../e2e/server.ts';
import { fakeCameraArgs } from '../../e2e/camera-video.ts';

const seed = Number(process.argv[2]);
const server = await serveDist();
for (const interval of process.argv.slice(3).map(Number)) {
  const dir = mkdtempSync(join(tmpdir(), 'validate-'));
  const video = join(dir, 'cam.y4m');
  const mk = spawnSync('npx', ['tsx', 'bench/sendrate/make-video.ts', String(seed), String(interval), video], { encoding: 'utf8' });
  if (mk.status !== 0) throw new Error(mk.stderr);
  const browser = await chromium.launch({ args: fakeCameraArgs(video) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(server.url);
    await page.getByRole('button', { name: /Receive transfer/ }).click();
    const t0 = Date.now();
    await page.getByText('All files received and verified').waitFor({ timeout: 180_000 });
    const wall = (Date.now() - t0) / 1000;
    const speed = await page.locator('.speed-final').first().innerText();
    await page.locator('details.advanced summary').click();
    const diag = (await page.locator('details.advanced p.small').first().innerText()).replace(/\s+/g, ' ');
    console.log(`REAL APP seed ${seed} ${interval} ms: ${speed} | wall ${wall.toFixed(1)} s from opening the camera | ${diag} | video ${(statSync(video).size / 1e6).toFixed(0)} MB`);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
await server.close();
