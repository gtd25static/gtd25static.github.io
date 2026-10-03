import { useEffect } from 'react';
import { isParanoidEnabled, lock } from '../db/vault';

export const DEFAULT_BACKGROUND_LOCK_SECONDS = 30;

/** Clamp the user-entered delay to [0, 300] s; 0 means "lock the instant the tab hides". */
export function clampBackgroundLockSeconds(value: string | number): number {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (Number.isNaN(n)) return DEFAULT_BACKGROUND_LOCK_SECONDS;
  return Math.max(0, Math.min(300, Math.floor(n)));
}

// Paranoid extra (opt-in): lock the vault after the tab has been hidden for N
// seconds. Complements the IdleDetector path (src/lib/system-idle.ts), which
// sees OS idle and screen locks but NOT tab switches — and is Chromium-only.
// Mounted from UnlockedApp, so it only ever runs while unlocked.
//
// Honest limit: browsers throttle background-tab timers, so the lock can fire
// late — read the delay as "at least N seconds", not exactly N. (visibility
// events themselves are not throttled, so the 0 = immediate case is exact.)
// Timers also stand still while the machine sleeps or the tab is frozen, so on
// coming back the time hidden is judged on the wall clock: past the delay, it
// locks — the pending timer used to be cancelled before it had ever fired.
// A page that is frozen (Android) or put in the back/forward cache runs no code
// at all, so the key would sit in memory for as long as it stays there: those
// moments lock at once. And starting while already hidden counts from now —
// an unlock that finished in the background used to wait for the NEXT change.
export function useBackgroundLock(enabled: boolean, seconds: number): void {
  useEffect(() => {
    if (!enabled || !isParanoidEnabled()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (seconds <= 0) {
          lock();
        } else {
          hiddenAt = Date.now();
          timer = setTimeout(() => { lock(); }, seconds * 1000);
        }
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
        if (Date.now() - hiddenAt >= seconds * 1000) lock();
      }
    };
    const onPageHide = (event: PageTransitionEvent) => { if (event.persisted) lock(); };
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('freeze', lock);
    window.addEventListener('pagehide', onPageHide);
    if (document.visibilityState === 'hidden') onVisibility();
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('freeze', lock);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [enabled, seconds]);
}
