/**
 * Full optical loop in real browsers: the built SENDER app transmits; each
 * code it shows is screenshotted, "filmed" by a simulated hand-held phone
 * camera (scripts/make_camera_video.py) and fed to a second Chromium as its
 * camera. The built RECEIVER app must scan, verify and save every file
 * byte-for-byte. Also covers the camera-denied path.
 *
 * Requires: `npm run build`, Playwright Chromium, python3 + OpenCV.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { serveDist } from './server.ts';

const hasCv2 = spawnSync('python3', ['-c', 'import cv2'], { stdio: 'ignore' }).status === 0;
let server: Awaited<ReturnType<typeof serveDist>>;
const dir = mkdtempSync(join(tmpdir(), 'optisend-rx-'));

before(async () => { server = await serveDist(); });
after(async () => { await server?.close(); rmSync(dir, { recursive: true, force: true }); });

function bytes(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >>> 16; }
  return b;
}

const FILES = [
  { name: 'diagram.png', mimeType: 'image/png', buffer: bytes(2600, 11) },
  { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Received through a camera, verified with SHA-256. '.repeat(14)) },
];

/** Run the sender app and screenshot every distinct code it displays. */
async function recordSender(browser: Browser): Promise<string[]> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(server.url);
  await page.getByRole('button', { name: /Send files/ }).click();
  await page.setInputFiles('#file-input', FILES);
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
  await page.close();
  return shots;
}

test('sender app → simulated phone camera → receiver app: files verified and saved byte-for-byte', { skip: !hasCv2 && 'python3/OpenCV not available', timeout: 300_000 }, async () => {
  const senderBrowser = await chromium.launch();
  let shots: string[];
  try {
    shots = await recordSender(senderBrowser);
  } finally {
    await senderBrowser.close();
  }
  assert.ok(shots.length >= 10, `captured ${shots.length} codes`);

  const video = join(dir, 'camera.y4m');
  const mk = spawnSync('python3', ['scripts/make_camera_video.py', video, '6', '7', ...shots], { encoding: 'utf8' });
  assert.equal(mk.status, 0, mk.stderr);

  const rxBrowser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
  try {
  const ctx = await rxBrowser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url);
  await page.getByRole('button', { name: /Receive transfer/ }).click();
  await page.getByText('Receiving…').or(page.getByText('All files received and verified')).first().waitFor({ timeout: 60_000 });
  await page.screenshot({ path: join(dir, 'rx-progress.png') });
  await page.getByText('All files received and verified').waitFor({ timeout: 120_000 });
  await page.screenshot({ path: join(dir, 'rx-done.png') });
  if (process.env.OPTISEND_SHOTS) {
    writeFileSync(join(process.env.OPTISEND_SHOTS, 'rx-progress.png'), readFileSync(join(dir, 'rx-progress.png')));
    writeFileSync(join(process.env.OPTISEND_SHOTS, 'rx-done.png'), readFileSync(join(dir, 'rx-done.png')));
  }

  for (const f of FILES) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: `Save ${f.name}`, exact: true }).click()]);
    assert.equal(dl.suggestedFilename(), f.name);
    const got = readFileSync((await dl.path())!);
    assert.ok(got.equals(f.buffer), `${f.name} content differs`);
  }
  const diag = await page.evaluate(() => document.querySelector('.stats.compact')?.textContent ?? '');
  console.log(`# ${shots.length} codes filmed; receiver stats: ${diag}`);

  // Leaving the receiver keeps the files; the home screen lists them.
  await page.getByRole('button', { name: 'Stop receiving' }).click();
  await page.getByRole('heading', { name: 'Received files' }).waitFor();
  assert.equal(await page.locator('.rx-file .badge-verified').count(), FILES.length);
  assert.deepEqual(errors, []);
  } finally {
    await rxBrowser.close();
  }
});

for (const [errName, expectTitle, expectHelp] of [
  ['NotAllowedError', /permission denied/i, /Allow camera access/],
  ['NotFoundError', /No camera found/i, /does not report a camera/],
  ['NotReadableError', /Camera is busy/i, /Another app/],
] as const) {
  test(`camera error ${errName} shows actionable help and a working retry`, { timeout: 60_000 }, async () => {
    const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      // Make the FIRST camera request fail like a real browser would; later requests succeed.
      await page.addInitScript((name: string) => {
        const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        let calls = 0;
        navigator.mediaDevices.getUserMedia = (c?: MediaStreamConstraints) =>
          ++calls === 1 ? Promise.reject(new DOMException('simulated', name)) : real(c);
      }, errName);
      await page.goto(server.url);
      await page.getByRole('button', { name: /Receive transfer/ }).click();
      const alert = page.getByRole('alert');
      await alert.waitFor({ timeout: 15_000 });
      const text = await alert.innerText();
      assert.match(text, expectTitle);
      assert.match(text, expectHelp);
      await page.getByRole('button', { name: 'Try again' }).click();
      await page.getByText('Point the camera at the sender’s screen').waitFor({ timeout: 15_000 });
      assert.equal(await page.getByRole('alert').count(), 0);
    } finally {
      await browser.close();
    }
  });
}
