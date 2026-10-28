import { useEffect } from 'react';

interface WakeLockSentinelLike { release(): Promise<void>; addEventListener?(t: 'release', cb: () => void): void }
interface WakeLockLike { request(type: 'screen'): Promise<WakeLockSentinelLike> }

/** Keep the screen on while `active` (Screen Wake Lock API, where supported). */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const wl = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!active || !wl) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      wl.request('screen').then(
        (s) => { if (disposed) void s.release(); else sentinel = s; },
        () => undefined, // denied / unsupported: transmission still works
      );
    };
    acquire();
    // Locks are released when the page is hidden; re-acquire on return.
    document.addEventListener('visibilitychange', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', acquire);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}
