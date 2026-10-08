// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import '../setup-component';
import { useWakeTick } from '../../hooks/use-wake-tick';

describe('useWakeTick', () => {
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('advances once the wake time has passed, not before', () => {
    const wakeAt = Date.now() + 60_000;
    const { result } = renderHook(() => useWakeTick(wakeAt));
    act(() => { vi.advanceTimersByTime(59_999); });
    expect(result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(result.current).toBe(1);
  });

  it('does nothing with no wake to wait for', () => {
    const { result } = renderHook(() => useWakeTick(0));
    act(() => { vi.advanceTimersByTime(10 * 24 * 60 * 60 * 1000); });
    expect(result.current).toBe(0);
  });

  it('waits in steps for a wake past the longest timeout (~24.8 days)', () => {
    const wakeAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const { result } = renderHook(() => useWakeTick(wakeAt));
    // The first step fires early; the counter moving there is harmless (a re-read).
    act(() => { vi.advanceTimersByTime(25 * 24 * 60 * 60 * 1000); });
    const afterStep = result.current;
    act(() => { vi.advanceTimersByTime(5 * 24 * 60 * 60 * 1000 + 1_000); });
    expect(result.current).toBe(afterStep + 1);
  });

  it('advances when the page comes back after the wake (a hidden tab runs timers late)', () => {
    const wakeAt = Date.now() + 60_000;
    const { result } = renderHook(() => useWakeTick(wakeAt));
    visibility = 'hidden';
    // Time passes without the timer running.
    vi.setSystemTime(wakeAt + 5_000);
    visibility = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current).toBe(1);
  });

  it('coming back before the wake does not advance it', () => {
    const wakeAt = Date.now() + 60_000;
    const { result } = renderHook(() => useWakeTick(wakeAt));
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current).toBe(0);
  });
});
