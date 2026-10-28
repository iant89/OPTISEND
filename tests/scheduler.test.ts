import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransmissionScheduler, type Clock, type FrameEvent } from '../src/features/sender/scheduler.ts';

/** Deterministic fake clock. `lag` adds a delay to every timer firing (simulates jitter). */
class FakeClock implements Clock {
  t = 0;
  lag = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private id = 0;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.id; this.timers.set(id, { at: this.t + ms + this.lag, fn }); return id; }
  clearTimeout(h: unknown) { this.timers.delete(h as number); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = end;
  }
}

function setup(frames = ['m', 'a', 'b', 'c'], passes: number | 'continuous' = 2, intervalMs = 750) {
  const clock = new FakeClock();
  const s = new TransmissionScheduler<string>({ frames, passes, intervalMs, clock });
  const shown: FrameEvent<string>[] = [];
  const states: string[] = [];
  s.onFrame((e) => shown.push(e));
  s.onState((st) => states.push(st));
  return { clock, s, shown, states };
}

test('shows each frame for the interval and finishes after N passes', () => {
  const { clock, s, shown, states } = setup();
  s.start();
  assert.deepEqual(shown.map((e) => e.frame), ['m']);
  clock.advance(749);
  assert.equal(shown.length, 1);
  clock.advance(1);
  assert.equal(shown.length, 2);
  clock.advance(750 * 10);
  assert.deepEqual(shown.map((e) => `${e.pass}${e.frame}`), ['1m', '1a', '1b', '1c', '2m', '2a', '2b', '2c']);
  assert.equal(s.state, 'finished');
  assert.deepEqual(states, ['running', 'finished']);
  assert.equal(s.stats.passesCompleted, 2);
  assert.ok(s.stats.allBroadcast);
  assert.equal(s.stats.activeMs, 8 * 750);
});

test('timer jitter does not accumulate drift', () => {
  const { clock, s, shown } = setup(['a', 'b'], 'continuous', 100);
  clock.lag = 7; // every timer fires 7 ms late
  const times: number[] = [];
  s.onFrame(() => times.push(clock.now()));
  s.start();
  clock.advance(100 * 1000 + 50);
  // Frame k is due at k*100; each fires ≤ 7 ms late but lateness never compounds.
  times.forEach((t, k) => assert.ok(t >= k * 100 && t <= k * 100 + 7, `frame ${k} at ${t}`));
  assert.ok(shown.length >= 999);
  assert.equal(s.stats.lateResyncs, 0);
});

test('falling far behind (throttled tab) re-anchors instead of bursting', () => {
  const { clock, s, shown } = setup(['a', 'b', 'c'], 'continuous', 100);
  s.start();
  clock.t = 1100; // the page was frozen for a second; the 100 ms timer is now overdue
  clock.advance(0);
  const before = shown.length;
  assert.equal(before, 2);
  clock.advance(99);
  assert.equal(shown.length, before, 'no burst of catch-up frames');
  clock.advance(1);
  assert.equal(shown.length, before + 1);
  assert.equal(s.stats.lateResyncs, 1);
});

test('pause holds the frame; resume gives it a full interval', () => {
  const { clock, s, shown } = setup();
  s.start();
  clock.advance(500);
  s.pause();
  assert.equal(s.state, 'paused');
  clock.advance(10_000);
  assert.equal(shown.length, 1);
  s.resume();
  clock.advance(749);
  assert.equal(shown.length, 1);
  clock.advance(1);
  assert.equal(shown.at(-1)!.frame, 'a');
  assert.equal(s.stats.activeMs, 500 + 750);
  s.togglePause();
  assert.equal(s.state, 'paused');
  s.togglePause();
  assert.equal(s.state, 'running');
});

test('next/prev step manually, wrap around, and work while paused', () => {
  const { clock, s, shown } = setup();
  s.start();
  s.pause();
  s.prev();
  assert.equal(shown.at(-1)!.frame, 'c');
  assert.equal(shown.at(-1)!.manual, true);
  s.next();
  s.next();
  assert.equal(shown.at(-1)!.frame, 'a');
  clock.advance(5000);
  assert.equal(shown.at(-1)!.frame, 'a', 'still paused');
  s.resume();
  s.next();
  assert.equal(shown.at(-1)!.frame, 'b');
  clock.advance(749);
  assert.equal(shown.at(-1)!.frame, 'b', 'manual step resets the display period');
  clock.advance(1);
  assert.equal(shown.at(-1)!.frame, 'c');
});

test('stop, restart and repeat pass', () => {
  const { clock, s, shown, states } = setup(['x', 'y'], 1, 100);
  s.start();
  clock.advance(1000);
  assert.equal(s.state, 'finished');
  s.repeatPass();
  assert.equal(s.state, 'running');
  assert.equal(shown.at(-1)!.pass, 2);
  clock.advance(1000);
  assert.equal(s.state, 'finished');
  assert.equal(s.stats.passesCompleted, 2);
  s.restart();
  assert.deepEqual(s.position, { index: 0, pass: 1 });
  clock.advance(50);
  s.stop();
  assert.equal(s.state, 'stopped');
  clock.advance(1000);
  const n = shown.length;
  clock.advance(1000);
  assert.equal(shown.length, n);
  assert.ok(states.includes('stopped'));
});

test('continuous mode loops until stopped; interval can change live', () => {
  const { clock, s, shown } = setup(['a', 'b'], 'continuous', 100);
  s.start();
  clock.advance(1000);
  assert.equal(s.state, 'running');
  assert.equal(shown.at(-1)!.pass, 6);
  s.setIntervalMs(500);
  const n = shown.length;
  clock.advance(499);
  assert.equal(shown.length, n);
  clock.advance(1);
  assert.equal(shown.length, n + 1);
  assert.throws(() => s.setIntervalMs(10));
});

test('hold factor lengthens chosen frames (e.g. manifests)', () => {
  const clock = new FakeClock();
  const s = new TransmissionScheduler<string>({ frames: ['M', 'd1', 'd2'], passes: 1, intervalMs: 100, clock, holdFactor: (f) => (f === 'M' ? 2 : 1) });
  const times: number[] = [];
  s.onFrame(() => times.push(clock.now()));
  s.start();
  clock.advance(10_000);
  assert.deepEqual(times, [0, 200, 300]);
  assert.equal(s.passDurationMs(), 400);
});

test('peek returns upcoming frames for pre-rendering', () => {
  const { s } = setup(['a', 'b', 'c']);
  s.start();
  assert.deepEqual(s.peek(2), ['b', 'c']);
  s.next();
  s.next();
  assert.deepEqual(s.peek(2), ['a', 'b']);
});

test('rejects bad configuration', () => {
  assert.throws(() => new TransmissionScheduler({ frames: [], passes: 1, intervalMs: 750 }));
  assert.throws(() => new TransmissionScheduler({ frames: ['a'], passes: 0, intervalMs: 750 }));
  assert.throws(() => new TransmissionScheduler({ frames: ['a'], passes: 1.5, intervalMs: 750 }));
  assert.throws(() => new TransmissionScheduler({ frames: ['a'], passes: 1, intervalMs: Number.NaN }));
});
