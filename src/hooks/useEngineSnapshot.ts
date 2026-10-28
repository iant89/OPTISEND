import { useEffect, useState } from 'react';
import type { ReceiverEngine, SessionSnapshot } from '../protocol/receiver.ts';

/**
 * Re-render at most every `intervalMs` while the engine is receiving packets
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
    const off = engine.subscribe(() => {
      if (timer !== null) return;
      const wait = Math.max(0, intervalMs - (performance.now() - last));
      timer = setTimeout(flush, wait);
    });
    flush();
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [engine, intervalMs]);
  return state;
}
