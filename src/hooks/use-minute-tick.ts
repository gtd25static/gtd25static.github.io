import { useEffect, useState } from 'react';

const MINUTE_MS = 60_000;

/**
 * A counter that advances once a minute while the page is visible, and again
 * when it becomes visible. Pass it as a useLiveQuery dependency when the query
 * compares against Date.now(): a liveQuery only re-runs on DB writes, so a
 * recurrence falling due or a snooze running out would otherwise stay
 * invisible until something unrelated is written.
 */
export function useMinuteTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    };
    const interval = setInterval(bump, MINUTE_MS);
    document.addEventListener('visibilitychange', bump);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', bump);
    };
  }, []);
  return tick;
}
