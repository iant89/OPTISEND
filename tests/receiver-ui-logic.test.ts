import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecoderChain } from '../src/qr/decoders/chain.ts';
import { decodeWithJsQr } from '../src/qr/decoders/jsqr-core.ts';
import type { FrameDecoder, ScanFrame, ScanHit } from '../src/qr/decoders/types.ts';
import { encodeQr, type QrMatrix } from '../src/qr/encoder.ts';
import { acceptHit } from '../src/features/receiver/scanner.ts';
import { regionOnElement, scanRegion, targetScanSide } from '../src/features/receiver/region.ts';
import { bitmapToSegments } from '../src/features/receiver/segments.ts';
import { pickActiveSession } from '../src/features/receiver/ReceiveScreen.tsx';
import { classifyCameraError, describeCameraError } from '../src/camera/camera.ts';
import { safeMimeType } from '../src/features/files/download.ts';
import { ChunkBitmap } from '../src/protocol/bitmap.ts';
import { frameForQr } from '../src/protocol/transport.ts';
import { PAYLOAD_PRESETS, maxChunkPayload } from '../src/qr/capacity.ts';
import type { SessionSnapshot } from '../src/protocol/receiver.ts';
import { allDataPackets, makeBytes, plan } from './helpers.ts';

/** Render a matrix to RGBA at `scale` px/module with a 4-module quiet zone, optionally offset in a larger canvas. */
export function rasterize(m: QrMatrix, scale: number, pad = 0): ScanFrame {
  const n = m.size + 8;
  const W = n * scale + pad * 2;
  const data = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.modules[y * m.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((pad + (y + 4) * scale + dy) * W + pad + (x + 4) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: W, height: W };
}

// ─── jsQR against our encoder ───

test('jsQR reads our codes exactly — binary bytes and Base45 text — at every preset', async () => {
  for (const preset of Object.values(PAYLOAD_PRESETS)) {
    for (const transport of ['byte', 'alphanumeric'] as const) {
      const cs = maxChunkPayload(preset.version, preset.ecc, transport);
      const p = await plan([{ name: 'x.bin', data: makeBytes(cs * 2, preset.version) }], cs);
      const pkt = (await allDataPackets(p))[0]!;
      const m = encodeQr(frameForQr(pkt, transport), { ecc: preset.ecc, minVersion: preset.version });
      const hit = decodeWithJsQr(rasterize(m, 3, 20));
      assert.ok(hit, `${preset.id}/${transport} decodes`);
      assert.equal(hit.version, preset.version);
      const accepted = acceptHit(hit);
      assert.ok(accepted, `${preset.id}/${transport} accepted`);
      assert.deepEqual([...accepted], [...pkt]);
    }
  }
});

test('acceptHit rejects foreign and corrupted codes', () => {
  assert.equal(acceptHit({ text: 'https://example.com', bytes: new TextEncoder().encode('https://example.com') }), null);
  assert.equal(acceptHit({ text: 'OS:%%%', bytes: null }), null);
  assert.equal(acceptHit({ text: null, bytes: Uint8Array.from([0x4f, 0x53, 1, 2, 3]) }), null);
});

// ─── Decoder chain ───

class FakeDecoder implements FrameDecoder {
  calls = 0;
  lastData: Uint8ClampedArray | null = null;
  constructor(readonly id: string, private readonly result: ScanHit | null, readonly binary = true, readonly label = id) {}
  async decode(f: ScanFrame) {
    this.calls++;
    this.lastData = f.data;
    return this.result;
  }
}

test('chain: first mode stops at the first accepted hit and falls through rejected ones', async () => {
  const good: ScanHit = { text: 'good', bytes: null };
  const bad: ScanHit = { text: 'bad', bytes: null };
  const a = new FakeDecoder('native', bad, false);
  const b = new FakeDecoder('jsqr', good);
  const c = new FakeDecoder('other', good);
  const chain = new DecoderChain([a, b, c], 'first');
  const frame: ScanFrame = { data: new Uint8ClampedArray(16), width: 2, height: 2 };
  const r = await chain.decode(frame, (h) => (h.text === 'good' ? h.text : null));
  assert.equal(r?.decoderId, 'jsqr');
  assert.equal(c.calls, 0);
  // Earlier decoders get copies; only the last gets the original buffer.
  assert.notEqual(a.lastData, frame.data);
  const s = chain.snapshotStats();
  assert.deepEqual(s.map((x) => [x.id, x.attempts, x.hits, x.accepted, x.rescued]), [['native', 1, 1, 0, 0], ['jsqr', 1, 1, 1, 1], ['other', 0, 0, 0, 0]]);
});

test('chain: all mode runs every decoder and credits the first acceptor', async () => {
  const a = new FakeDecoder('native', { text: 'x', bytes: null }, false);
  const b = new FakeDecoder('jsqr', { text: 'x', bytes: null });
  const chain = new DecoderChain([a, b], 'all');
  const frame: ScanFrame = { data: new Uint8ClampedArray(16), width: 2, height: 2 };
  const r = await chain.decode(frame, (h) => h.text);
  assert.equal(r?.decoderId, 'native');
  assert.equal(b.lastData, frame.data);
  assert.deepEqual(chain.snapshotStats().map((x) => [x.accepted, x.rescued]), [[1, 0], [1, 0]]);
  assert.equal(await new DecoderChain([new FakeDecoder('n', null)]).decode(frame, () => 1), null);
});

test('chain: a throwing decoder is treated as a miss', async () => {
  const boom: FrameDecoder = { id: 'boom', label: 'boom', binary: true, decode: async () => { throw new Error('x'); } };
  const chain = new DecoderChain([boom, new FakeDecoder('ok', { text: 'y', bytes: null })]);
  const r = await chain.decode({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, (h) => h.text);
  assert.equal(r?.decoderId, 'ok');
});

// ─── Region geometry ───

test('scan region is a centered square, downscaled but never upscaled', () => {
  assert.deepEqual(scanRegion(1920, 1080, 0.85, 960), { sx: 501, sy: 81, sSize: 918, dSize: 918 });
  assert.deepEqual(scanRegion(1920, 1080, 0.85, 640), { sx: 501, sy: 81, sSize: 918, dSize: 640 });
  assert.deepEqual(scanRegion(720, 1280, 1, 2000), { sx: 0, sy: 280, sSize: 720, dSize: 720 });
  assert.equal(targetScanSide(null), 960);
  assert.equal(targetScanSide(15), 850);
  assert.equal(targetScanSide(40), 1600);
  assert.equal(targetScanSide(1), 640);
});

test('regionOnElement maps the scan square through object-fit: cover', () => {
  const r = scanRegion(1280, 720, 0.5, 960); // 360px square at (460,180)
  // Element 390×300: scale = max(390/1280, 300/720) = 0.4167; video drawn 533×300, offset x = -71.7
  const g = regionOnElement(1280, 720, 390, 300, r);
  assert.ok(Math.abs(g.size - 150) < 0.01);
  assert.ok(Math.abs(g.top - 75) < 0.01);
  assert.ok(Math.abs(g.left - 120) < 0.01);
});

// ─── Display helpers ───

test('bitmapToSegments is exact up to the limit and conservative beyond it', () => {
  const small = new ChunkBitmap(10);
  small.set(2);
  assert.deepEqual([...bitmapToSegments(small)], [0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  const big = new ChunkBitmap(10_000);
  for (let i = 0; i < 5000; i++) big.set(i);
  big.set(7000);
  const segs = bitmapToSegments(big, 100);
  assert.equal(segs.length, 100);
  assert.equal(segs.filter((s) => s === 1).length, 50); // the lone chunk 7000 never fills its bucket
});

test('pickActiveSession prefers the most recent incomplete session', () => {
  const s = (id: string, lastActivity: number, complete: boolean) => ({ sessionId: id, lastActivity, complete }) as SessionSnapshot;
  assert.equal(pickActiveSession([]), null);
  assert.equal(pickActiveSession([s('a', 1, false), s('b', 5, true), s('c', 3, false)])!.sessionId, 'c');
  assert.equal(pickActiveSession([s('a', 1, true), s('b', 5, true)])!.sessionId, 'b');
});

test('camera errors are classified with actionable help', () => {
  assert.equal(classifyCameraError({ name: 'NotAllowedError' }).kind, 'denied');
  assert.equal(classifyCameraError({ name: 'NotFoundError' }).kind, 'not-found');
  assert.equal(classifyCameraError({ name: 'NotReadableError' }).kind, 'in-use');
  assert.equal(classifyCameraError({ name: 'OverconstrainedError' }).kind, 'overconstrained');
  assert.equal(classifyCameraError({ name: 'NotSupportedError' }).kind, 'unsupported');
  assert.equal(classifyCameraError(new Error('?')).kind, 'unknown');
  for (const k of ['insecure-context', 'unsupported', 'denied', 'not-found', 'in-use', 'overconstrained', 'unknown'] as const) {
    const d = describeCameraError(k);
    assert.ok(d.title.length > 0 && d.help.length > 20);
  }
});

test('download MIME types are allow-listed; active content is never passed through', () => {
  assert.equal(safeMimeType('application/pdf'), 'application/pdf');
  assert.equal(safeMimeType('Image/PNG'), 'image/png');
  assert.equal(safeMimeType('text/html'), 'application/octet-stream');
  assert.equal(safeMimeType('image/svg+xml'), 'application/octet-stream');
  assert.equal(safeMimeType('text/plain; charset=utf-8'), 'application/octet-stream');
  assert.equal(safeMimeType('<script>'), 'application/octet-stream');
  assert.equal(safeMimeType(null), 'application/octet-stream');
});
