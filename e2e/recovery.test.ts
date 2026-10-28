/**
 * Phase 4 in the real app (spec §15.2: page reloads during reception, storage
 * failures; §11.2 storage management): a camera transfer interrupted by a
 * reload resumes from IndexedDB; verified files persist and can be saved,
 * deleted and cleared; a full quota shows actionable help.
 *
 * Requires: `npm run build`, Playwright Chromium, python3 + OpenCV.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { serveDist } from './server.ts';
import { bytes, fakeCameraArgs, makeVideo, recordSender, type TestFile } from './camera-video.ts';

const hasCv2 = spawnSync('python3', ['-c', 'import cv2'], { stdio: 'ignore' }).status === 0;
const skip = !hasCv2 && 'python3/OpenCV not available';
let server: Awaited<ReturnType<typeof serveDist>>;
const dir = mkdtempSync(join(tmpdir(), 'optisend-rec-'));
const video = join(dir, 'camera.y4m');

const FILES: TestFile[] = [
  { name: 'report.pdf', mimeType: 'application/pdf', buffer: bytes(4200, 21) },
  { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Persisted in IndexedDB and restored after a reload. '.repeat(12)) },
];

before(async () => {
  server = await serveDist();
  if (skip) return;
  const b = await chromium.launch();
  try {
    makeVideo(await recordSender(b, server.url, FILES, dir), video);
  } finally {
    await b.close();
  }
});
after(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const validChunks = async (page: Page) => Number((await page.locator('.stats.compact div').first().locator('dd').innerText()).replace(/\D/g, '') || '0');

test('reload mid-transfer → progress restored from IndexedDB → resume → verified files persist, save, delete, clear', { skip, timeout: 300_000 }, async () => {
  const browser: Browser = await chromium.launch({ args: fakeCameraArgs(video) });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.getByRole('button', { name: /Receive transfer/ }).click();

    // Wait for partial progress, then pull the plug.
    const t0 = Date.now();
    let got = 0;
    while (Date.now() - t0 < 60_000) {
      got = await validChunks(page);
      if (got >= 3) break;
      await page.waitForTimeout(150);
    }
    assert.ok(got >= 3, `received ${got} chunks before reload`);
    await page.reload();

    // Home shows the restored, incomplete transfer.
    await page.getByRole('heading', { name: 'Incomplete transfers' }).waitFor();
    assert.match(await page.locator('.notice').first().innerText(), /Restored 2 files/);
    const incomplete = page.locator('section[aria-labelledby="inc-h"] .rx-file');
    assert.equal(await incomplete.count(), 1);
    const pct = Number((await incomplete.locator('.row-between .small').innerText()).replace('%', ''));
    assert.ok(pct > 0 && pct < 100, `restored progress ${pct}%`);

    // Resume: restored chunks show immediately, then the transfer completes.
    await incomplete.getByRole('button', { name: 'Resume receiving' }).click();
    assert.ok((await validChunks(page)) >= got - 0, 'restored chunks visible before scanning');
    await page.getByText('All files received and verified').waitFor({ timeout: 120_000 });
    await page.getByRole('button', { name: 'Stop receiving' }).click();

    // Reload again: both files are listed as received, straight from IndexedDB.
    await page.reload();
    await page.getByRole('heading', { name: 'Received files' }).waitFor();
    const rows = page.locator('section[aria-labelledby="rx-h"] .rx-file');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 2);
    for (const f of FILES) {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: `Save ${f.name}`, exact: true }).click()]);
      assert.ok(readFileSync((await dl.path())!).equals(f.buffer), `${f.name} restored byte-for-byte`);
    }
    await page.screenshot({ path: join(process.env.OPTISEND_SHOTS ?? dir, 'home-restored.png'), fullPage: true });

    // Delete one file (with confirmation); it stays deleted after a reload.
    await page.getByRole('button', { name: 'Delete notes.txt' }).click();
    await page.getByRole('group', { name: /Confirm deleting notes.txt/ }).getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="rx-h"] .rx-file').length === 1);
    await page.reload();
    await page.getByRole('heading', { name: 'Received files' }).waitFor();
    await page.locator('section[aria-labelledby="rx-h"] .rx-file').first().waitFor();
    assert.equal(await page.locator('section[aria-labelledby="rx-h"] .rx-file').count(), 1);
    assert.match(await page.locator('section[aria-labelledby="rx-h"]').innerText(), /report\.pdf/);

    // Clear all data (two-step confirmation) → empty after reload.
    await page.getByRole('button', { name: 'Clear all data…' }).click();
    await page.getByRole('button', { name: 'Delete everything' }).click();
    await page.getByText('All received and incomplete transfers were deleted.').waitFor();
    await page.reload();
    await page.getByText('Nothing received yet.').waitFor();
    assert.equal(await page.getByText('None.').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('full browser storage shows an actionable "storage is full" banner and nothing is miscounted', { skip, timeout: 180_000 }, async () => {
  const browser = await chromium.launch({ args: fakeCameraArgs(video) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const cdp = await page.context().newCDPSession(page);
    await page.goto(server.url);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(server.url).origin, quotaSize: 2_500 });
    await page.getByRole('button', { name: /Receive transfer/ }).click();
    const alert = page.locator('.notice-error');
    await alert.waitFor({ timeout: 90_000 });
    const text = await alert.innerText();
    assert.match(text, /Storage is full/);
    assert.match(text, /Delete old transfers/);
    // Progress only reflects what was actually stored.
    const pct = Number((await page.locator('.session-pct').innerText()).replace('%', ''));
    assert.ok(pct < 100, `progress ${pct}% must not claim completion`);
    assert.equal(await page.getByText('All files received and verified').count(), 0);
  } finally {
    await browser.close();
  }
});
