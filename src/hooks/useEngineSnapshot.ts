import { useEffect, useState } from 'react';
import type { ReceiverEngine, SessionSnapshot } from '../protocol/receiver.ts';

/**
 * Re-render at most every `intervalMs` while the engine is receiving packets or changing state
 * (spec §16: throttle progress renders while preserving exact counters).
 */
export function useEngineSnapshot(engine: ReceiverEngine, intervalMs = 250): { sessions: SessionSnapshot[]; tick: number } {
  const [state, setState] = useState(() => ({ sessions: engine.snapshot(), tick: 0 }));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const flush = () => {
      timer = null;
      last = performance.now();
      setState((s) => ({ sessions: engine.snapshot(), tick: s.tick + 1 }));
    };
    const schedule = () => {
      if (timer !== null) return;
      const wait = Math.max(0, intervalMs - (performance.now() - last));
      timer = setTimeout(flush, wait);
    };
    // Packets (progress) and state changes such as deletes, resets and restores.
    const off = engine.subscribe(schedule);
    const offChange = engine.onChange(schedule);
    flush();
    return () => {
      off();
      offChange();
      if (timer !== null) clearTimeout(timer);
    };
  }, [engine, intervalMs]);
  return state;
}
