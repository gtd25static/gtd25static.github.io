// Best-effort system-wide auto-lock via the Idle Detection API.
//
// Unlike the in-app idle timer, this reports OS-level idleness and screen-lock
// state, so the vault can lock when you step away from the machine entirely (or
// lock your screen) even if the app is in the background. Limitations: Chromium
// only (Chrome/Edge — not Safari/Firefox), permission-gated, and can be disabled
// by enterprise policy. Everywhere it's unavailable this is a no-op and the app
// falls back to the in-app idle timer.

import { recordError } from './diagnostics';

interface IdleDetectorLike {
  userState: 'active' | 'idle' | null;
  screenState: 'locked' | 'unlocked' | null;
  addEventListener(type: 'change', cb: () => void): void;
  start(opts: { threshold: number; signal: AbortSignal }): Promise<void>;
}
interface IdleDetectorCtor {
  new (): IdleDetectorLike;
  requestPermission(): Promise<PermissionState>;
}

export interface SystemIdleLockOptions {
  // A number, or a getter evaluated at each screen-lock event — so "Relaxed unlock"
  // can vary the grace live without rebuilding the detector (which would reset OS
  // idle detection).
  screenLockGraceMs?: number | (() => number);
  // Called when the detector could not be started (permission revoked, blocked by
  // enterprise policy, start() rejected). Without it the failure is invisible: the
  // toggle keeps reading "on" while stepping away no longer locks anything.
  onUnavailable?: (reason: 'unsupported' | 'error', err?: unknown) => void;
}

/** Default screen-lock grace, in minutes, when the grace is enabled but unset. */
export const DEFAULT_SYSTEM_LOCK_GRACE_MINUTES = 10;

/**
 * Clamp a user-entered screen-lock grace to a sane [1, 60] minute range. A larger
 * grace keeps the DEK resident longer after an OS screen lock (see THREAT_MODEL
 * Scenario 3), so the upper bound is deliberately tighter than the idle timeout.
 */
export function clampSystemLockGraceMinutes(value: string | number): number {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (Number.isNaN(n)) return DEFAULT_SYSTEM_LOCK_GRACE_MINUTES;
  return Math.max(1, Math.min(60, Math.floor(n)));
}

function getCtor(): IdleDetectorCtor | null {
  return (globalThis as { IdleDetector?: IdleDetectorCtor }).IdleDetector ?? null;
}

export function isSystemIdleSupported(): boolean {
  return getCtor() !== null;
}

/** Must be called from a user gesture. Returns true once permission is granted. */
export async function requestSystemIdlePermission(): Promise<boolean> {
  const Ctor = getCtor();
  if (!Ctor) return false;
  try {
    return (await Ctor.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Start watching for system idle / screen lock; calls onLock() when system idle
 * is reached, and either immediately or after an optional grace when the screen
 * locks. Returns a stop() function. No-op (returns a no-op stop) when the API is
 * unavailable or permission was not granted.
 */
export async function startSystemIdleLock(
  thresholdMs: number,
  onLock: () => void,
  options: SystemIdleLockOptions = {},
): Promise<() => void> {
  const Ctor = getCtor();
  if (!Ctor) {
    options.onUnavailable?.('unsupported');
    return () => {};
  }
  try {
    const controller = new AbortController();
    const detector = new Ctor();
    const graceOpt = options.screenLockGraceMs ?? 0;
    const getGraceMs = () => Math.max(0, typeof graceOpt === 'function' ? graceOpt() : graceOpt);
    let screenLockTimer: ReturnType<typeof setTimeout> | null = null;
    const clearScreenLockTimer = () => {
      if (screenLockTimer) {
        clearTimeout(screenLockTimer);
        screenLockTimer = null;
      }
    };
    const lockNow = () => {
      clearScreenLockTimer();
      onLock();
    };
    detector.addEventListener('change', () => {
      if (detector.userState === 'idle') {
        lockNow();
        return;
      }
      if (detector.screenState === 'locked') {
        const graceMs = getGraceMs(); // read live (Relaxed unlock may have changed it)
        if (graceMs === 0) {
          lockNow();
        } else if (!screenLockTimer) {
          screenLockTimer = setTimeout(lockNow, graceMs);
        }
        return;
      }
      clearScreenLockTimer();
    });
    // The spec floors the threshold at 60s.
    await detector.start({ threshold: Math.max(60_000, thresholdMs), signal: controller.signal });
    return () => {
      clearScreenLockTimer();
      controller.abort();
    };
  } catch (err) {
    // A silent no-op here means the user believes stepping away locks the vault
    // when it does not — the one failure in this file that must be visible.
    recordError('systemIdle.start', err);
    options.onUnavailable?.('error', err);
    return () => {};
  }
}
