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

interface Shot { path: string; /** The sender's description of the frame, e.g. "File 1 of 2 · chunk 3 of 9". */ label: string }

/** Run the sender app and screenshot every distinct code it displays. */
async function recordSender(browser: Browser, opts: { colour: boolean; passes: 1 | 2; prefix: string }): Promise<Shot[]> {
  const { colour } = opts;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(server.url);
  await page.getByRole('button', { name: /Send files/ }).click();
  await page.setInputFiles('#file-input', FILES);
  await page.getByText('1 s', { exact: true }).click();
  await page.getByText(`${opts.passes}×`).click();
  if (colour) {
    await page.getByText('Advanced').click();
    await page.getByLabel(/Colour: 3 codes per frame/).check();
  }
  await page.getByText('Ready to transmit.').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Start transfer' }).click();
  const shots: Shot[] = [];
  let last = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const sig = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('.transmit .qr-canvas');
      return c && !c.hidden && c.width ? c.toDataURL().slice(-200) : '';
    });
    if (sig && sig !== last) {
      last = sig;
      const p = join(dir, `${opts.prefix}${String(shots.length).padStart(3, '0')}.png`);
      await page.screenshot({ path: p });
      const label = await page.locator('.frame-info').innerText();
      shots.push({ path: p, label });
    }
    if (await page.locator('.transmit.state-finished').count()) break;
    await page.waitForTimeout(80);
  }
  await page.close();
  return shots;
}

const VARIANTS = [
  { title: '', colour: false, fountain: false },
  { title: ' (colour: 3 codes per frame)', colour: true, fountain: false },
  { title: ' (fountain: pass-1 codes never seen, rebuilt from repair codes)', colour: false, fountain: true },
] as const;

for (const { title, colour, fountain } of VARIANTS) test(`sender app → simulated phone camera → receiver app${title}: files verified and saved byte-for-byte`, { skip: !hasCv2 && 'python3/OpenCV not available', timeout: 300_000 }, async () => {
  const senderBrowser = await chromium.launch();
  let shots: Shot[];
  try {
    shots = await recordSender(senderBrowser, { colour, passes: fountain ? 2 : 1, prefix: fountain ? 'fountain' : colour ? 'colour' : 'shot' });
  } finally {
    await senderBrowser.close();
  }
  // 15 packets: one per frame in black and white; data packets three per frame in colour.
  assert.ok(shots.length >= (colour ? 5 : 10), `captured ${shots.length} codes`);
  let dropped = 0;
  if (fountain) {
    // Pass 2 shows repair codes (fountain coding is on by default). Remove some pass-1 data frames from
    // the film, so those chunks are never seen directly and can only be rebuilt from repair codes.
    assert.ok(shots.some((s) => /repair code/.test(s.label)), `pass 2 shows repair codes: ${shots.map((s) => s.label.split('\n')[1]).join(' | ')}`);
    const pass1Data = shots.filter((s) => /Pass 1/.test(s.label) && /chunk \d+ of/.test(s.label));
    const lose = new Set([
      ...pass1Data.filter((s) => /File 1 of/.test(s.label)).slice(1, 3),
      ...pass1Data.filter((s) => /File 2 of/.test(s.label)).slice(1, 2),
    ]);
    assert.equal(lose.size, 3);
    shots = shots.filter((s) => !lose.has(s));
    dropped = lose.size;
  }

  const video = join(dir, fountain ? 'camera-fountain.y4m' : colour ? 'camera-colour.y4m' : 'camera.y4m');
  const mk = spawnSync('python3', ['scripts/make_camera_video.py', video, '6', '7', ...shots.map((s) => s.path)], { encoding: 'utf8' });
  assert.equal(mk.status, 0, mk.stderr);

  const rxBrowser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
  try {
  const ctx = await rxBrowser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Every request (page and workers) must stay on the app's own server: no CDN for the ZXing WebAssembly.
  const requests: string[] = [];
  ctx.on('request', (r) => requests.push(r.url()));
  // Main-thread responsiveness: record long tasks (≥ 50 ms) while receiving.
  await ctx.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__longTasks.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch { /* unsupported */ }
  });
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

  // Per-file speed: first captured chunk → verified. The sender shows one ~280-byte code per
  // second, so a plausible rate is a few hundred bytes per second.
  const speeds = await page.locator('.rx-file .speed-final').allInnerTexts();
  assert.equal(speeds.length, FILES.length, JSON.stringify(speeds));
  for (const text of speeds) {
    // A file whose chunks all arrive in one capture has no meaningful rate (colour mode packs 3 chunks per frame).
    if (/^Received instantly/.test(text)) continue;
    const m = /Received in (\d+)s · ([\d.]+) (B|KB)\/s/.exec(text);
    assert.ok(m, `speed text: ${text}`);
    const bps = Number(m[2]) * (m[3] === 'KB' ? 1024 : 1);
    assert.ok(bps > 50 && bps < 3000, `implausible rate ${text}`);
  }
  console.log(`# per-file speeds: ${speeds.join(' | ')}`);

  for (const f of FILES) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: `Save ${f.name}`, exact: true }).click()]);
    assert.equal(dl.suggestedFilename(), f.name);
    const got = readFileSync((await dl.path())!);
    assert.ok(got.equals(f.buffer), `${f.name} content differs`);
  }
  const diag = await page.evaluate(() => document.querySelector('.stats.compact')?.textContent ?? '');
  // Chunks rebuilt from repair codes: exactly the ones cut from the film in the fountain run, none otherwise.
  const rebuilt = Number(/Rebuilt([\d,]+)/.exec(diag)?.[1]?.replace(/,/g, '') ?? 0);
  assert.equal(rebuilt, dropped, `rebuilt chunks (stats: ${diag})`);
  console.log(`# ${shots.length} codes filmed; receiver stats: ${diag}`);
  const scanInfo = await page.evaluate(() => document.querySelector('.receive details p.muted.small')?.textContent ?? '');
  console.log(`# scanner: ${scanInfo}`);
  const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
  console.log(`# main-thread long tasks (≥50 ms) during the session: ${longTasks.length}${longTasks.length ? ` (max ${Math.max(...longTasks)} ms, total ${longTasks.reduce((x, y) => x + y, 0)} ms)` : ''}`);
  if (colour) {
    assert.match(scanInfo, /[1-9][\d,]* colour frames/, 'the receiver split colour frames into channels');
    assert.ok(requests.some((u) => u.endsWith('/assets/colour.worker.js')), 'colour frames are split in the colour worker');
  }
  else assert.doesNotMatch(scanInfo, /colour frames/, 'black-and-white frames are never treated as colour');

  // Automatic mode decoded with ZXing (WebAssembly) in its worker, loaded from the app itself.
  const decoders = await page.evaluate(() => [...document.querySelectorAll('.diag-table tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent ?? '')));
  console.log(`# decoders (name, read, accepted, avg ms): ${JSON.stringify(decoders)}`);
  const zx = decoders.find((r) => r[0]?.startsWith('ZXing'));
  assert.ok(zx && Number.parseInt(zx[2]!, 10) > 0, `ZXing accepted codes: ${JSON.stringify(decoders)}`);
  assert.ok(!decoders.some((r) => r[0]?.startsWith('jsQR')), 'jsQR is only a fallback when ZXing is available');
  assert.ok(requests.some((u) => u.endsWith('/assets/zxing_reader.wasm')), 'WebAssembly loaded from the app');
  const foreign = requests.filter((u) => !u.startsWith(server.url) && !u.startsWith('blob:') && !u.startsWith('data:'));
  assert.deepEqual(foreign, []);

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

test('if the ZXing WebAssembly cannot load, the receiver falls back to jsQR', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/zxing_reader.wasm', (r) => r.fulfill({ status: 404, body: 'blocked' }));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.getByRole('button', { name: /Receive transfer/ }).click();
    // The decoder table appears once the scanner runs; with ZXing unavailable, Automatic uses jsQR.
    await page.locator('.diag-table tbody tr').first().waitFor({ state: 'attached', timeout: 20_000 });
    const names = await page.evaluate(() => [...document.querySelectorAll('.diag-table tbody th')].map((th) => th.textContent ?? ''));
    assert.deepEqual(names, ['jsQR']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
