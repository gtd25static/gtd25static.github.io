// Best-effort system-wide auto-lock via the Idle Detection API.
//
// Unlike the in-app idle timer, this reports OS-level idleness and screen-lock
// state, so the vault can lock when you step away from the machine entirely (or
// lock your screen) even if the app is in the background. Limitations: Chromium
// only (Chrome/Edge — not Safari/Firefox), permission-gated, and can be disabled
// by enterprise policy. Everywhere it's unavailable this is a no-op and the app
// falls back to the in-app idle timer.

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
 * Start watching for system idle / screen lock; calls onLock() when either is
 * reached. Returns a stop() function. No-op (returns a no-op stop) when the API
 * is unavailable or permission was not granted.
 */
export async function startSystemIdleLock(thresholdMs: number, onLock: () => void): Promise<() => void> {
  const Ctor = getCtor();
  if (!Ctor) return () => {};
  try {
    const controller = new AbortController();
    const detector = new Ctor();
    detector.addEventListener('change', () => {
      if (detector.userState === 'idle' || detector.screenState === 'locked') onLock();
    });
    // The spec floors the threshold at 60s.
    await detector.start({ threshold: Math.max(60_000, thresholdMs), signal: controller.signal });
    return () => controller.abort();
  } catch {
    return () => {};
  }
}
