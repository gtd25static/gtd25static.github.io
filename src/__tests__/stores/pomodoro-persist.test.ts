import { vi } from 'vitest';

// Reliability review 2026-10-06 (B24): the running timer lived in memory only —
// an update's reload, a re-key's reload or Android killing the PWA in the
// background lost it, and no bell ever came.

const KEY = 'gtd25-pomodoro-end';

async function freshStore() {
  vi.resetModules();
  return (await import('../../stores/pomodoro-store')).usePomodoroStore;
}

afterEach(() => localStorage.removeItem(KEY));

it('a running timer survives a reload', async () => {
  const store = await freshStore();
  store.getState().startPlus25();
  const end = store.getState().timerEndTime;

  const reloaded = await freshStore();

  expect(reloaded.getState().timerRunning).toBe(true);
  expect(reloaded.getState().timerEndTime).toBe(end);
});

it('one that ended while the page was gone completes at the first tick (the bell rings)', async () => {
  localStorage.setItem(KEY, String(Date.now() - 60_000));
  const store = await freshStore();
  expect(store.getState().timerRunning).toBe(true);
  expect(store.getState().tick().completed).toBe(true);
});

it('one that ended long ago is dropped quietly', async () => {
  localStorage.setItem(KEY, String(Date.now() - 3 * 60 * 60 * 1000));
  const store = await freshStore();
  expect(store.getState().timerRunning).toBe(false);
  expect(localStorage.getItem(KEY)).toBeNull();
});

it('stopping forgets it', async () => {
  const store = await freshStore();
  store.getState().startPlus25();
  store.getState().stopTimer();
  expect(localStorage.getItem(KEY)).toBeNull();
});
