// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import '../setup-component';

// Reliability review 2026-10-06 (B23): the midnight refresh fired once and was
// never re-armed — a window left open showed yesterday's "completed today" and
// streak from the second midnight on.

const h = vi.hoisted(() => ({ deps: [] as unknown[][] }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_fn: unknown, deps: unknown[]) => { h.deps.push(deps); return undefined; },
}));

import { useMotivationStats } from '../../hooks/use-motivation-stats';

beforeEach(() => {
  h.deps.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 6, 22, 0));
});
afterEach(() => vi.useRealTimers());

const refreshes = () => new Set(h.deps.map((d) => d[1])).size - 1;

it('refreshes at every midnight, not only the first', async () => {
  renderHook(() => useMotivationStats());

  await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);

  expect(refreshes()).toBeGreaterThanOrEqual(3);
});

it('catches up on coming back after the device slept through midnight', async () => {
  renderHook(() => useMotivationStats());
  // Asleep: the clock jumped, the timer did not fire.
  vi.setSystemTime(new Date(2026, 9, 7, 9, 0));
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);

  expect(refreshes()).toBeGreaterThanOrEqual(1);
});
