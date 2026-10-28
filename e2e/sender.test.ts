/**
 * Browser end-to-end: drive the built app in Chromium, capture every QR code
 * actually drawn on screen, decode the pixels with independent decoders
 * (OpenCV + WeChat), and feed the results to the Phase 1 ReceiverEngine.
 * The transfer passes only if every file is rebuilt byte-for-byte and verified.
 *
 * Requires: `npm run build`, Playwright's Chromium, python3 + OpenCV.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { bytesEqual } from '../src/crypto/bytes.ts';
import { MemoryChunkStore } from '../src/protocol/chunk-store.ts';
import { ReceiverEngine } from '../src/protocol/receiver.ts';
import { unframeScan } from '../src/protocol/transport.ts';
import { serveDist } from './server.ts';
import { readPixelPerfectQr, SAMPLE_CANVAS_FN } from './qr-read.ts';

const hasCv2 = spawnSync('python3', ['-c', 'import cv2'], { stdio: 'ignore' }).status === 0;
let browser: Browser;
let server: Awaited<ReturnType<typeof serveDist>>;

before(async () => {
  server = await serveDist();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

function bytes(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >>> 16; }
  return b;
}

async function pickAndConfigure(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[], textSafe: boolean) {
  await page.goto(server.url);
  await page.getByRole('button', { name: /Send files/ }).click();
  await page.setInputFiles('#file-input', files);
  await page.getByText('500 ms').click();
  await page.getByText('1×').click();
  await page.getByText('Advanced').click();
  const box = page.getByLabel(/Text-safe encoding/);
  if (textSafe) await box.check();
  else await box.uncheck();
  await page.getByText('Ready to transmit.').waitFor({ timeout: 15_000 });
}

interface Captured { png: string; n: number; bits: string }

/** Grab each distinct frame the canvas shows (PNG + sampled modules) until the broadcast finishes. */
async function captureFrames(page: Page): Promise<Captured[]> {
  return page.evaluate(async (sampleSrc) => {
    const seen = new Set<string>();
    const out: { png: string; n: number; bits: string }[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 120_000) {
      const c = document.querySelector<HTMLCanvasElement>('.transmit .qr-canvas');
      if (c && !c.hidden && c.width > 0) {
        const png = c.toDataURL('image/png');
        if (!seen.has(png)) {
          seen.add(png);
          // Indirect eval of a plain string (a named helper would pick up tsx's __name shim).
          const m = (0, eval)(sampleSrc) as { n: number; bits: string } | null;
          if (m) out.push({ png, n: m.n, bits: m.bits });
        }
      }
      if (document.querySelector('.transmit.state-finished')) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    return out;
  }, SAMPLE_CANVAS_FN);
}

function decodePngs(dataUrls: string[]): { cv: string | null; wechat: string | null }[] {
  const dir = mkdtempSync(join(tmpdir(), 'optisend-e2e-'));
  const paths = dataUrls.map((u, i) => {
    const p = join(dir, `f${i}.png`);
    writeFileSync(p, Buffer.from(u.split(',')[1]!, 'base64'));
    return p;
  });
  const r = spawnSync('python3', ['scripts/decode_images.py'], { input: JSON.stringify(paths), encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

for (const textSafe of [true, false]) {
  test(`on-screen QR frames rebuild the files exactly (${textSafe ? 'text-safe Base45' : 'binary'} transport)`, { skip: !hasCv2 && 'python3/OpenCV not available', timeout: 180_000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const files = [
      { name: 'photo.bin', mimeType: 'application/octet-stream', buffer: bytes(4000, 1) },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('OptiSend end-to-end ✓ '.repeat(40)) },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('a different file with the same name') },
      { name: 'empty.dat', mimeType: '', buffer: Buffer.alloc(0) },
    ];
    await pickAndConfigure(page, files, textSafe);
    await page.getByRole('button', { name: 'Start transfer' }).click();
    const frames = await captureFrames(page);
    await page.locator('.transmit-status.finished').waitFor({ timeout: 10_000 });

    // Path A — independent camera-style decoders (OpenCV + WeChat) reading the PNG pixels.
    const decoded = decodePngs(frames.map((f) => f.png));
    const rxText = new ReceiverEngine({ store: new MemoryChunkStore() });
    let unreadable = 0;
    for (const d of decoded) {
      const pkt = [d.wechat, d.cv].map((t) => (t ? unframeScan({ text: t }) : null)).find((p) => p) ?? null;
      if (!pkt) { unreadable++; continue; }
      await rxText.ingest(pkt);
    }
    // Path B — pixel-exact reader: raw segment bytes with every Reed–Solomon block checked.
    const rx = new ReceiverEngine({ store: new MemoryChunkStore() });
    for (const f of frames) {
      const { content } = readPixelPerfectQr(f.n, Uint8Array.from(f.bits, (c) => (c === '1' ? 1 : 0)));
      const pkt = typeof content === 'string' ? unframeScan({ text: content }) : unframeScan({ bytes: content });
      assert.ok(pkt, 'frame is an OptiSend packet');
      await rx.ingest(pkt);
    }

    if (textSafe) {
      // Text-safe frames must survive real decoders end to end.
      const st = rxText.snapshot()[0];
      const r = JSON.stringify({ frames: frames.length, unreadable, stats: rxText.stats });
      assert.ok(st?.complete, r);
      assert.equal(unreadable, 0, r);
      assert.equal(rxText.stats.rejected, 0, r);
      console.log(`# text-safe via OpenCV/WeChat: ${r}`);
    } else {
      // Desktop decoders return byte-mode content as text (truncating at NUL / re-encoding bytes).
      // The protocol must turn that into clean rejections — never bad data.
      assert.equal(rxText.stats.accepted, 0);
      assert.ok(rxText.snapshot().every((x) => x.files.every((f) => f.status !== 'hash-mismatch')));
      console.log(`# binary via text-only decoders (expected to be rejected cleanly): ${JSON.stringify(rxText.stats.rejectReasons)}`);
    }

    const s = rx.snapshot()[0];
    const report = JSON.stringify({ frames: frames.length, stats: rx.stats, files: s?.files.map((f) => [f.name, f.status, f.missingChunks]) });

    assert.ok(s, report);
    assert.equal(rx.stats.rejected, 0, report);
    assert.ok(s.complete, report);
    for (const [i, f] of files.entries()) {
      const got = Buffer.concat(await Array.fromAsync(rx.readFile(s.sessionId, i)));
      assert.ok(bytesEqual(got, f.buffer), `file ${i} differs`);
      assert.equal(s.files[i]!.name, f.name);
    }
    assert.deepEqual(errors, []);
    console.log(`# ${report}`);
    await page.close();
  });
}

test('controls: pause holds the frame, next/prev step, stop shows the honest summary', { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(server.url);
  await page.getByRole('button', { name: /Send files/ }).click();
  await page.setInputFiles('#file-input', [{ name: 'a.bin', mimeType: '', buffer: bytes(3000, 2) }]);
  await page.getByText('Ready to transmit.').waitFor();
  await page.getByRole('button', { name: 'Start transfer' }).click();
  await page.getByRole('button', { name: 'Pause' }).waitFor();
  await page.getByRole('button', { name: 'Pause' }).click();
  const info = () => page.locator('.frame-info').innerText();
  const before = await info();
  await page.waitForTimeout(1600);
  assert.equal(await info(), before, 'paused frame does not advance');
  await page.getByRole('button', { name: 'Next code' }).click();
  const stepped = await info();
  assert.notEqual(stepped, before);
  await page.getByRole('button', { name: 'Previous code' }).click();
  assert.equal(await info(), before);
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.waitForTimeout(1700);
  assert.notEqual(await info(), before, 'resumed');
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('heading', { name: 'Transmission stopped' }).waitFor();
  assert.match(await page.locator('.notice').innerText(), /not what was captured/);
  // Keyboard: Transmit again, then Space pauses.
  await page.getByRole('button', { name: 'Transmit again' }).click();
  await page.getByRole('button', { name: 'Pause' }).waitFor();
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Resume' }).waitFor();
  await page.close();
});

test('accessibility basics: names, focus, touch targets, no horizontal scroll', { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
  await page.goto(server.url);
  await page.getByRole('button', { name: /Send files/ }).click();
  await page.setInputFiles('#file-input', [{ name: 'x'.repeat(120) + '.txt', mimeType: 'text/plain', buffer: bytes(500, 3) }]);
  await page.getByText('Ready to transmit.').waitFor();
  const res = await page.evaluate(() => {
    const small: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, .chip, .choice, select, input[type=number], .btn')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.height < 43.5 || r.width < 43.5)) small.push(`${el.tagName}.${el.className} ${r.width}x${r.height}`);
    }
    const unnamed = [...document.querySelectorAll('button')].filter((b) => !(b.getAttribute('aria-label') || b.textContent?.trim())).length;
    return { small, unnamed, scrollW: document.documentElement.scrollWidth, w: window.innerWidth };
  });
  assert.deepEqual(res.small, []);
  assert.equal(res.unnamed, 0);
  assert.ok(res.scrollW <= res.w, `horizontal overflow ${res.scrollW} > ${res.w}`);
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  assert.ok(focused && focused !== 'BODY');
  await page.close();
});
