import { vi } from 'vitest';
import {
  isSystemIdleSupported, requestSystemIdlePermission, startSystemIdleLock,
  DEFAULT_SYSTEM_LOCK_GRACE_MINUTES, clampSystemLockGraceMinutes,
} from '../../lib/system-idle';

interface GlobalWithIdle { IdleDetector?: unknown }

// Shared fake detector instance so the test can flip userState/screenState and
// fire the 'change' event the module subscribes to.
function installFakeIdleDetector(permission: PermissionState) {
  const instance = {
    userState: 'active' as 'active' | 'idle',
    screenState: 'unlocked' as 'locked' | 'unlocked',
    cb: () => {},
    addEventListener(_type: string, cb: () => void) { instance.cb = cb; },
    start: vi.fn().mockResolvedValue(undefined),
  };
  const Ctor = function () { return instance; } as unknown as { new (): typeof instance; requestPermission: () => Promise<PermissionState> };
  (Ctor as { requestPermission: () => Promise<PermissionState> }).requestPermission = vi.fn().mockResolvedValue(permission);
  (globalThis as GlobalWithIdle).IdleDetector = Ctor;
  return instance;
}

afterEach(() => {
  delete (globalThis as GlobalWithIdle).IdleDetector;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('system-idle (IdleDetector)', () => {
  it('reports unsupported and no-ops when IdleDetector is absent', async () => {
    expect(isSystemIdleSupported()).toBe(false);
    expect(await requestSystemIdlePermission()).toBe(false);
    const onLock = vi.fn();
    const stop = await startSystemIdleLock(60_000, onLock);
    stop();
    expect(onLock).not.toHaveBeenCalled();
  });

  it('returns false when permission is denied', async () => {
    installFakeIdleDetector('denied');
    expect(isSystemIdleSupported()).toBe(true);
    expect(await requestSystemIdlePermission()).toBe(false);
  });

  it('locks on system idle and on screen lock', async () => {
    const detector = installFakeIdleDetector('granted');
    expect(await requestSystemIdlePermission()).toBe(true);

    const onLock = vi.fn();
    await startSystemIdleLock(60_000, onLock);
    expect(detector.start).toHaveBeenCalled();

    detector.cb();                  // active + unlocked -> no lock
    expect(onLock).not.toHaveBeenCalled();

    detector.userState = 'idle';
    detector.cb();                  // idle -> lock
    expect(onLock).toHaveBeenCalledTimes(1);

    detector.userState = 'active';
    detector.screenState = 'locked';
    detector.cb();                  // screen locked -> lock
    expect(onLock).toHaveBeenCalledTimes(2);
  });

  it('defers screen-lock app lock when a grace period is configured', async () => {
    vi.useFakeTimers();
    const detector = installFakeIdleDetector('granted');
    const onLock = vi.fn();

    await startSystemIdleLock(60_000, onLock, { screenLockGraceMs: 10 * 60_000 });

    detector.screenState = 'locked';
    detector.cb();
    expect(onLock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(onLock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('cancels deferred screen-lock app lock when the screen unlocks', async () => {
    vi.useFakeTimers();
    const detector = installFakeIdleDetector('granted');
    const onLock = vi.fn();

    await startSystemIdleLock(60_000, onLock, { screenLockGraceMs: 10 * 60_000 });

    detector.screenState = 'locked';
    detector.cb();
    detector.screenState = 'unlocked';
    detector.userState = 'active';
    detector.cb();

    vi.advanceTimersByTime(10 * 60_000);
    expect(onLock).not.toHaveBeenCalled();
  });

  it('still locks immediately on system idle when screen-lock grace is configured', async () => {
    vi.useFakeTimers();
    const detector = installFakeIdleDetector('granted');
    const onLock = vi.fn();

    await startSystemIdleLock(60_000, onLock, { screenLockGraceMs: 10 * 60_000 });

    detector.userState = 'idle';
    detector.cb();

    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('clears a pending screen-lock timer when stopped', async () => {
    vi.useFakeTimers();
    const detector = installFakeIdleDetector('granted');
    const onLock = vi.fn();

    const stop = await startSystemIdleLock(60_000, onLock, { screenLockGraceMs: 10 * 60_000 });
    detector.screenState = 'locked';
    detector.cb();

    stop();
    vi.advanceTimersByTime(10 * 60_000);

    expect(onLock).not.toHaveBeenCalled();
  });
});

describe('screen-lock grace config', () => {
  it('defaults to 10 minutes', () => {
    expect(DEFAULT_SYSTEM_LOCK_GRACE_MINUTES).toBe(10);
  });

  it('clamps the grace to [1, 60] minutes and floors fractions', () => {
    expect(clampSystemLockGraceMinutes('15')).toBe(15);
    expect(clampSystemLockGraceMinutes(15)).toBe(15);
    expect(clampSystemLockGraceMinutes('0')).toBe(1);
    expect(clampSystemLockGraceMinutes('-5')).toBe(1);
    expect(clampSystemLockGraceMinutes('999')).toBe(60);
    expect(clampSystemLockGraceMinutes('12.9')).toBe(12);
  });

  it('falls back to the default for non-numeric input', () => {
    expect(clampSystemLockGraceMinutes('')).toBe(DEFAULT_SYSTEM_LOCK_GRACE_MINUTES);
    expect(clampSystemLockGraceMinutes('abc')).toBe(DEFAULT_SYSTEM_LOCK_GRACE_MINUTES);
  });

  it('defers the app lock by the default grace when fed as the screen-lock grace', async () => {
    vi.useFakeTimers();
    const detector = installFakeIdleDetector('granted');
    const onLock = vi.fn();

    await startSystemIdleLock(60_000, onLock, {
      screenLockGraceMs: DEFAULT_SYSTEM_LOCK_GRACE_MINUTES * 60_000,
    });

    detector.screenState = 'locked';
    detector.cb();
    vi.advanceTimersByTime(DEFAULT_SYSTEM_LOCK_GRACE_MINUTES * 60_000 - 1);
    expect(onLock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLock).toHaveBeenCalledTimes(1);
  });
});
