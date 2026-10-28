/** Shared e2e helpers: run the sender app, screenshot each code, and turn them into a fake-camera video. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Browser } from 'playwright';

export interface TestFile { name: string; mimeType: string; buffer: Buffer }

export function bytes(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >>> 16; }
  return b;
}

/** Run the sender app (1 s per code, one pass) and screenshot every distinct code it displays. */
export async function recordSender(browser: Browser, url: string, files: TestFile[], dir: string): Promise<string[]> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(url);
    await page.getByRole('button', { name: /Send files/ }).click();
    await page.setInputFiles('#file-input', files);
    await page.getByText('1 s', { exact: true }).click();
    await page.getByText('1×').click();
    await page.getByText('Ready to transmit.').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Start transfer' }).click();
    const shots: string[] = [];
    let last = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const sig = await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('.transmit .qr-canvas');
        return c && !c.hidden && c.width ? c.toDataURL().slice(-200) : '';
      });
      if (sig && sig !== last) {
        last = sig;
        const p = join(dir, `shot${String(shots.length).padStart(3, '0')}.png`);
        await page.screenshot({ path: p });
        shots.push(p);
      }
      if (await page.locator('.transmit.state-finished').count()) break;
      await page.waitForTimeout(80);
    }
    return shots;
  } finally {
    await page.close();
  }
}

/** Film the screenshots with a simulated hand-held phone (scripts/make_camera_video.py). */
export function makeVideo(shots: string[], out: string, framesPerCode = 6, seed = 7): void {
  const mk = spawnSync('python3', ['scripts/make_camera_video.py', out, String(framesPerCode), String(seed), ...shots], { encoding: 'utf8' });
  if (mk.status !== 0) throw new Error(mk.stderr);
}

export const fakeCameraArgs = (video: string) => ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`];
