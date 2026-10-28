/**
 * Transmission scheduler (spec §8). Framework-independent; the UI subscribes
 * to `frame` and `state` events.
 *
 * Timing: frame deadlines are computed from a monotonic anchor
 * (deadline = previous deadline + duration), so small timer delays never
 * accumulate into drift over long transfers. If the page falls badly behind
 * (e.g. a throttled background tab) the scheduler re-anchors instead of
 * flashing a burst of catch-up frames, and counts the event.
 */

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const browserClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type SchedulerState =
  /** Not started yet. */
  | 'idle'
  | 'running'
  | 'paused'
  /** User stopped broadcasting. */
  | 'stopped'
  /** The configured number of passes has been broadcast. */
  | 'finished';

export type PassCount = number | 'continuous';

export interface FrameEvent<T> {
  frame: T;
  /** 0-based index within the pass. */
  index: number;
  /** 1-based pass number. */
  pass: number;
  framesPerPass: number;
  /** True if shown by next()/prev() rather than the timer. */
  manual: boolean;
}

export interface SchedulerStats {
  /** Frames displayed (timer + manual). */
  framesShown: number;
  /** Passes fully broadcast. */
  passesCompleted: number;
  /** True once every frame has been displayed at least once. */
  allBroadcast: boolean;
  /** Times the scheduler fell more than one frame behind and re-anchored. */
  lateResyncs: number;
  /** Milliseconds spent in the running state. */
  activeMs: number;
}

export interface SchedulerOptions<T> {
  /** The frames of one pass, in order. */
  frames: readonly T[];
  intervalMs: number;
  passes: PassCount;
  /** Display-time multiplier per frame (e.g. hold manifest frames longer). Default 1. */
  holdFactor?: (frame: T) => number;
  clock?: Clock;
}

type Listener<E> = (e: E) => void;

export const MIN_INTERVAL_MS = 50;

export class TransmissionScheduler<T> {
  private readonly frames: readonly T[];
  private readonly clock: Clock;
  private readonly holdFactor: (frame: T) => number;
  private _interval: number;
  private _passes: PassCount;
  private _state: SchedulerState = 'idle';
  private index = 0;
  private pass = 1;
  private deadline = 0;
  private timer: unknown = null;
  private runningSince = 0;
  private readonly seen: Uint8Array;
  private seenCount = 0;
  private readonly _stats: SchedulerStats = { framesShown: 0, passesCompleted: 0, allBroadcast: false, lateResyncs: 0, activeMs: 0 };
  private readonly frameListeners = new Set<Listener<FrameEvent<T>>>();
  private readonly stateListeners = new Set<Listener<SchedulerState>>();

  constructor(opts: SchedulerOptions<T>) {
    if (opts.frames.length === 0) throw new RangeError('scheduler needs at least one frame');
    this.frames = opts.frames;
    this.clock = opts.clock ?? browserClock;
    this.holdFactor = opts.holdFactor ?? (() => 1);
    this._interval = checkInterval(opts.intervalMs);
    this._passes = checkPasses(opts.passes);
    this.seen = new Uint8Array(opts.frames.length);
  }

  // ── Observers ──

  get state(): SchedulerState { return this._state; }
  get intervalMs(): number { return this._interval; }
  get passes(): PassCount { return this._passes; }
  get framesPerPass(): number { return this.frames.length; }
  get position(): { index: number; pass: number } { return { index: this.index, pass: this.pass }; }
  get current(): T { return this.frames[this.index]!; }

  get stats(): Readonly<SchedulerStats> {
    const s = { ...this._stats };
    if (this._state === 'running') s.activeMs += this.clock.now() - this.runningSince;
    return s;
  }

  /** Upcoming frames after the current one (for pre-rendering), wrapping across passes. */
  peek(count: number): T[] {
    const out: T[] = [];
    for (let k = 1; k <= count && k < this.frames.length; k++) out.push(this.frames[(this.index + k) % this.frames.length]!);
    return out;
  }

  /** Like peek(), with the pass number each upcoming frame will be shown in. */
  peekWithPass(count: number): { frame: T; pass: number }[] {
    const out: { frame: T; pass: number }[] = [];
    const n = this.frames.length;
    for (let k = 1; k <= count && k < n; k++) {
      const i = this.index + k;
      out.push({ frame: this.frames[i % n]!, pass: this.pass + Math.floor(i / n) });
    }
    return out;
  }

  /** Estimated duration of one pass in ms at the current interval. */
  passDurationMs(): number {
    return this.frames.reduce((n, f) => n + this.durationOf(f), 0);
  }

  onFrame(l: Listener<FrameEvent<T>>): () => void {
    this.frameListeners.add(l);
    return () => this.frameListeners.delete(l);
  }

  onState(l: Listener<SchedulerState>): () => void {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }

  // ── Controls ──

  start(): void {
    if (this._state !== 'idle') return;
    this.setRunning();
    this.show(false);
    this.arm(this.clock.now() + this.durationOf(this.current));
  }

  pause(): void {
    if (this._state !== 'running') return;
    this.disarm();
    this.accumulateActive();
    this.setState('paused');
  }

  resume(): void {
    if (this._state !== 'paused') return;
    this.setRunning();
    // The current frame gets a full display period after resuming.
    this.arm(this.clock.now() + this.durationOf(this.current));
  }

  togglePause(): void {
    if (this._state === 'running') this.pause();
    else if (this._state === 'paused') this.resume();
  }

  stop(): void {
    if (this._state === 'stopped' || this._state === 'idle') return;
    this.disarm();
    if (this._state === 'running') this.accumulateActive();
    this.setState('stopped');
  }

  /** Start over from frame 1, pass 1 (keeps cumulative stats). */
  restart(): void {
    this.disarm();
    if (this._state === 'running') this.accumulateActive();
    this.index = 0;
    this.pass = 1;
    this._state = 'idle';
    this.start();
  }

  /** After finishing (or stopping), broadcast one more full pass from frame 1. */
  repeatPass(): void {
    if (this._state !== 'finished' && this._state !== 'stopped') return;
    this.pass++;
    this.index = 0;
    if (this._passes !== 'continuous') this._passes = this.pass;
    this.setRunning();
    this.show(false);
    this.arm(this.clock.now() + this.durationOf(this.current));
  }

  /** Manually step forward (troubleshooting). Keeps the current run/pause state. */
  next(): void { this.step(1); }
  /** Manually step back (troubleshooting). */
  prev(): void { this.step(-1); }

  setIntervalMs(ms: number): void {
    this._interval = checkInterval(ms);
    if (this._state === 'running') this.arm(this.clock.now() + this.durationOf(this.current));
  }

  setPasses(passes: PassCount): void {
    this._passes = checkPasses(passes);
  }

  dispose(): void {
    this.disarm();
    this.frameListeners.clear();
    this.stateListeners.clear();
  }

  // ── Internals ──

  private durationOf(frame: T): number {
    const f = this.holdFactor(frame);
    return this._interval * (Number.isFinite(f) && f > 0 ? f : 1);
  }

  private step(delta: number): void {
    if (this._state === 'idle') return;
    const n = this.frames.length;
    this.index = (this.index + delta + n) % n;
    this.show(true);
    if (this._state === 'running') this.arm(this.clock.now() + this.durationOf(this.current));
  }

  private tick = (): void => {
    this.timer = null;
    if (this._state !== 'running') return;
    const now = this.clock.now();

    // Advance position; detect pass boundaries.
    if (this.index === this.frames.length - 1) {
      this._stats.passesCompleted++;
      if (this._passes !== 'continuous' && this.pass >= this._passes) {
        this.accumulateActive();
        this.setState('finished');
        return;
      }
      this.pass++;
      this.index = 0;
    } else {
      this.index++;
    }
    this.show(false);

    let nextDeadline = this.deadline + this.durationOf(this.current);
    if (now - this.deadline > this._interval) {
      // Fell more than a frame behind: re-anchor rather than burst.
      this._stats.lateResyncs++;
      nextDeadline = now + this.durationOf(this.current);
    }
    this.arm(nextDeadline);
  };

  private show(manual: boolean): void {
    this._stats.framesShown++;
    if (!this.seen[this.index]) {
      this.seen[this.index] = 1;
      if (++this.seenCount === this.frames.length) this._stats.allBroadcast = true;
    }
    const e: FrameEvent<T> = { frame: this.current, index: this.index, pass: this.pass, framesPerPass: this.frames.length, manual };
    for (const l of this.frameListeners) l(e);
  }

  private arm(deadline: number): void {
    this.disarm();
    this.deadline = deadline;
    this.timer = this.clock.setTimeout(this.tick, Math.max(0, deadline - this.clock.now()));
  }

  private disarm(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private setRunning(): void {
    this.runningSince = this.clock.now();
    this.setState('running');
  }

  private accumulateActive(): void {
    this._stats.activeMs += this.clock.now() - this.runningSince;
  }

  private setState(s: SchedulerState): void {
    if (s === this._state) return;
    this._state = s;
    for (const l of this.stateListeners) l(s);
  }
}

function checkInterval(ms: number): number {
  if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) throw new RangeError(`interval must be ≥ ${MIN_INTERVAL_MS} ms`);
  return ms;
}

function checkPasses(p: PassCount): PassCount {
  if (p === 'continuous') return p;
  if (!Number.isInteger(p) || p < 1) throw new RangeError('passes must be a positive integer or "continuous"');
  return p;
}
