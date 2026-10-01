// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import '../setup-component';

const mockLock = vi.fn();
let paranoidOn = true;

vi.mock('../../db/vault', () => ({
  lock: () => mockLock(),
  isParanoidEnabled: () => paranoidOn,
}));

import {
  useBackgroundLock,
  clampBackgroundLockSeconds,
  DEFAULT_BACKGROUND_LOCK_SECONDS,
} from '../../hooks/use-background-lock';

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  paranoidOn = true;
  setVisibilityQuiet('visible');
});

afterEach(() => {
  vi.useRealTimers();
});

function setVisibilityQuiet(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

describe('useBackgroundLock', () => {
  it('locks after N seconds hidden', () => {
    renderHook(() => useBackgroundLock(true, 30));
    act(() => setVisibility('hidden'));
    act(() => { vi.advanceTimersByTime(29_000); });
    expect(mockLock).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(mockLock).toHaveBeenCalledTimes(1);
  });

  it('coming back in time cancels the pending lock', () => {
    renderHook(() => useBackgroundLock(true, 30));
    act(() => setVisibility('hidden'));
    act(() => { vi.advanceTimersByTime(20_000); });
    act(() => setVisibility('visible'));
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(mockLock).not.toHaveBeenCalled();
  });

  // The pending lock is a timer, and timers stand still while the machine sleeps
  // (or the tab is frozen): coming back after longer than the delay cancelled it
  // before it had ever fired.
  it('coming back after longer than the delay locks, though the timer never fired', () => {
    renderHook(() => useBackgroundLock(true, 30));
    act(() => setVisibility('hidden'));
    vi.setSystemTime(Date.now() + 60 * 60_000); // asleep: the wall clock moves, timers don't
    act(() => setVisibility('visible'));
    expect(mockLock).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(mockLock).toHaveBeenCalledTimes(1); // the stale timer does not lock again
  });

  it('0 seconds locks the instant the tab hides', () => {
    renderHook(() => useBackgroundLock(true, 0));
    act(() => setVisibility('hidden'));
    expect(mockLock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled or when Paranoid is off', () => {
    const { unmount } = renderHook(() => useBackgroundLock(false, 0));
    act(() => setVisibility('hidden'));
    expect(mockLock).not.toHaveBeenCalled();
    unmount();

    paranoidOn = false;
    setVisibilityQuiet('visible');
    renderHook(() => useBackgroundLock(true, 0));
    act(() => setVisibility('hidden'));
    expect(mockLock).not.toHaveBeenCalled();
  });

  it('unmounting (e.g. the vault locked another way) clears the pending timer', () => {
    const { unmount } = renderHook(() => useBackgroundLock(true, 30));
    act(() => setVisibility('hidden'));
    unmount();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(mockLock).not.toHaveBeenCalled();
  });
});

describe('clampBackgroundLockSeconds', () => {
  it('clamps to [0, 300] and defaults garbage input', () => {
    expect(clampBackgroundLockSeconds(0)).toBe(0);
    expect(clampBackgroundLockSeconds('45')).toBe(45);
    expect(clampBackgroundLockSeconds(9999)).toBe(300);
    expect(clampBackgroundLockSeconds(-5)).toBe(0);
    expect(clampBackgroundLockSeconds('nope')).toBe(DEFAULT_BACKGROUND_LOCK_SECONDS);
    expect(clampBackgroundLockSeconds(12.9)).toBe(12);
  });
});
