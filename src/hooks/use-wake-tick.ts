import { useEffect, useState } from 'react';

// setTimeout's delay is a signed 32-bit number of ms (~24.8 days): a wake
// farther out is waited for in steps.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// Fire just after the wake time, so the snooze has run out when the view re-reads it.
const SLACK_MS = 250;

/**
 * A counter that advances once `wakeAt` (epoch ms; 0 = nothing to wait for)
 * has passed. Put it in a liveQuery's deps, or just call it to re-render, so a
 * snoozed follow-up shows up when it wakes. One timer to the next wake, not a
 * tick every minute: in Paranoid Mode every re-read decrypts the rows. A hidden
 * tab's timers run late, so becoming visible after the wake also advances it.
 */
export function useWakeTick(wakeAt: number): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!wakeAt) return;
    const bump = () => setTick((t) => t + 1);
    const delay = Math.min(Math.max(0, wakeAt - Date.now()) + SLACK_MS, MAX_TIMEOUT_MS);
    const timer = setTimeout(bump, delay);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() >= wakeAt) bump();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [wakeAt, tick]);

  return tick;
}
