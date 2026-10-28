/**
 * Real IndexedDB in Chromium (spec §15.2: storage failures, page reloads during
 * reception). Uses a small harness bundle; quota exhaustion is produced with the
 * DevTools Protocol's Storage.overrideQuotaForOrigin.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { serveDist } from './server.ts';

let server: Awaited<ReturnType<typeof serveDist>>;
let browser: Browser;

before(async () => {
  mkdirSync('dist-harness', { recursive: true });
  await esbuild.build({ entryPoints: ['e2e/harness/storage-harness.ts'], bundle: true, format: 'esm', outfile: 'dist-harness/harness.js', logLevel: 'silent' });
  writeFileSync('dist-harness/index.html', '<!doctype html><meta charset="utf-8"><script type="module" src="./harness.js"></script>');
  server = await serveDist('dist-harness');
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.waitForFunction(() => 'harness' in window);
  return page;
}
const call = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).harness[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;

test('IdbChunkStore: put/get/list/delete by file and by session', async () => {
  const page = await open();
  const r = await call<any>(page, 'chunkStoreBasics');
  assert.deepEqual(r, { roundTrip: true, list0: [[0, 10], [1, 7]], afterFile: [0, 1], afterSession: [0, 1], missing: true });
  await page.close();
});

test('a real page reload mid-transfer resumes exactly where it left off', async () => {
  const page = await open();
  const db = 'optisend-test-reload';
  const a = await call<any>(page, 'receivePartial', db, 6); // manifest + 5 chunks
  assert.equal(a.durable, true);
  assert.equal(a.received, 5);
  await page.reload();
  await page.waitForFunction(() => 'harness' in window);
  const b = await call<any>(page, 'resumeAfterReload', db);
  assert.deepEqual(b.report, { sessions: 1, files: 1, lostChunks: 0, recoveredChunks: 0, discarded: 0, orphanBytesReclaimed: 0 });
  assert.equal(b.beforeReceived, 5, 'progress restored before any new packet');
  assert.equal(b.beforeName, 'file-9.bin', 'manifest metadata restored');
  assert.equal(b.duplicates, 6, 'already-stored chunks (and manifest) are not counted twice');
  assert.equal(b.status, 'verified');
  assert.equal(b.content, true);
  assert.equal(b.usage, 2000);

  await page.reload();
  await page.waitForFunction(() => 'harness' in window);
  const c = await call<any>(page, 'verifiedAfterReload', db);
  assert.deepEqual(c, { status: 'verified', ok: true, leftAfterDelete: 0, usageAfterDelete: 0, afterClear: 0 });
  const raw = await call<any[]>(page, 'sessionStoreRaw', db);
  assert.deepEqual(raw, []);
  await page.close();
});

test('storage quota exhaustion: writes fail cleanly, nothing is miscounted, and the transfer completes once space exists', async () => {
  const page = await open();
  const cdp = await page.context().newCDPSession(page);
  const origin = new URL(server.url).origin;
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 120_000 });
  const db = 'optisend-test-quota';
  const r = await call<any>(page, 'quotaRun', db);
  assert.ok((r.statuses['storage-error'] ?? 0) > 0, JSON.stringify(r));
  assert.ok(r.isQuotaClass, `error reported as quota: ${r.firstError}`);
  assert.ok(r.received > 0 && r.received < r.chunkCount, JSON.stringify(r));
  assert.ok(r.storedBytes <= r.received * 2800, 'only committed chunks count');
  assert.equal(r.statuses['accepted'], r.received);

  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 200 * 1024 * 1024 });
  await page.reload();
  await page.waitForFunction(() => 'harness' in window);
  const s = await call<any>(page, 'quotaRetry', db);
  assert.deepEqual(s, { status: 'verified', ok: true });
  await page.close();
});

test('orphaned chunks are reclaimed on open; a new transfer is saved immediately', async () => {
  const page = await open();
  const r = await call<any>(page, 'orphanCleanup', 'optisend-test-orphans');
  assert.deepEqual(r, { reclaimed: 500, left: 0, savedNow: 1 });
  await page.close();
});
