import { useEffect } from 'react';
import { db } from '../db';
import { useLocalSettings, updateLocalSettings } from './use-settings';
import { isParanoidEnabled, setRuntimeIdleTimeoutMs, DEFAULT_IDLE_MINUTES } from '../db/vault';
import { DEFAULT_SYSTEM_LOCK_GRACE_MINUTES } from '../lib/system-idle';
import { computeUnlockMultiplier, effectiveMinutes, pruneHistory } from '../lib/relaxed-unlock';
import { useRelaxedUnlockStore } from '../stores/relaxed-unlock';
import { recordError } from '../lib/diagnostics';

// Absolute ceilings (same as the settings inputs) the multiplied values can't exceed.
const ABS_MAX_IDLE_MIN = 240;
const ABS_MAX_GRACE_MIN = 60;
// Recompute periodically so the multiplier decays as unlocks age out of the 36h window.
const RECOMPUTE_INTERVAL_MS = 5 * 60_000;

/**
 * Drives "Relaxed unlock". While enabled (and Paranoid on + unlocked — this hook is
 * mounted in UnlockedApp), it multiplies the in-app idle auto-lock and the
 * screen-lock grace by computeUnlockMultiplier() over the device-local 36h unlock
 * history. Recomputes on mount (= just unlocked), on a timer, and on tab focus; the
 * idle value is updated WITHOUT re-arming (the next interaction re-arms it). On
 * disable/unmount it restores the base idle window and resets the shared store.
 */
export function useRelaxedUnlock(): void {
  const settings = useLocalSettings();
  const enabled = !!settings.relaxedUnlockEnabled;
  const baseIdleMin = settings.paranoidIdleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES;
  const baseGraceMin = settings.paranoidSystemLockGraceMinutes ?? DEFAULT_SYSTEM_LOCK_GRACE_MINUTES;
  const graceEnabled = !!settings.paranoidSystemLockGraceEnabled;

  useEffect(() => {
    if (!enabled || !isParanoidEnabled()) {
      setRuntimeIdleTimeoutMs(baseIdleMin * 60_000);
      useRelaxedUnlockStore.getState().reset();
      return;
    }

    let cancelled = false;
    const apply = async () => {
      try {
        const now = Date.now();
        const local = await db.localSettings.get('local');
        const history = pruneHistory(local?.unlockHistory ?? [], now);
        const multiplier = computeUnlockMultiplier(history, now);
        if (cancelled) return;
        setRuntimeIdleTimeoutMs(effectiveMinutes(baseIdleMin, multiplier, ABS_MAX_IDLE_MIN) * 60_000);
        useRelaxedUnlockStore.getState().set({
          multiplier,
          effectiveGraceMs: graceEnabled
            ? effectiveMinutes(baseGraceMin, multiplier, ABS_MAX_GRACE_MIN) * 60_000
            : 0,
        });
        // Persist the pruned history when it shrank, so it can't grow unbounded.
        if ((local?.unlockHistory?.length ?? 0) !== history.length) {
          await updateLocalSettings({ unlockHistory: history });
        }
      } catch (err) {
        recordError('relaxedUnlock.apply', err);
      }
    };

    void apply();
    const interval = setInterval(() => void apply(), RECOMPUTE_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void apply(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      setRuntimeIdleTimeoutMs(baseIdleMin * 60_000); // restore base so a relaxed value can't linger
      useRelaxedUnlockStore.getState().reset();
    };
  }, [enabled, baseIdleMin, baseGraceMin, graceEnabled, settings.paranoidEnabled]);
}
