// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import '../setup-component';
import { useMinuteTick } from '../../hooks/use-minute-tick';

describe('useMinuteTick', () => {
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('advances once a minute while visible', () => {
    const { result } = renderHook(() => useMinuteTick());
    expect(result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(59_999); });
    expect(result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(1);
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(result.current).toBe(3);
  });

  it('stays put while hidden and advances when the page becomes visible', () => {
    const { result } = renderHook(() => useMinuteTick());
    visibility = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(result.current).toBe(0);

    visibility = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current).toBe(1);
  });

  it('stops ticking after unmount', () => {
    const { result, unmount } = renderHook(() => useMinuteTick());
    unmount();
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    expect(result.current).toBe(0);
  });
});
