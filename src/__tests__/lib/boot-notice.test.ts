// @vitest-environment jsdom
import { vi } from 'vitest';
import { noticeIfSlow, showBootNotice } from '../../lib/boot-notice';

// Reliability review 2026-10-06 (B15): the start awaited IndexedDB before the
// first render with no limit — an upgrade or deletion blocked by another window
// (asleep, say) left a blank page with nothing said.

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

it('says what it is waiting for once the start takes long, and clears it when done', async () => {
  let finish!: () => void;
  const steps = new Promise<void>((r) => { finish = r; });
  const done = noticeIfSlow(steps, 5_000, () => showBootNotice('Waiting for another window'));

  await vi.advanceTimersByTimeAsync(4_000);
  expect(document.body.textContent).not.toContain('Waiting for another window');
  await vi.advanceTimersByTimeAsync(2_000);
  expect(document.body.textContent).toContain('Waiting for another window');

  finish();
  await done;
  expect(document.body.textContent).not.toContain('Waiting for another window');
});

it('a quick start shows nothing', async () => {
  await noticeIfSlow(Promise.resolve(), 5_000, () => showBootNotice('never'));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(document.body.textContent).toBe('');
});
