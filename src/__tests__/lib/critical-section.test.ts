import { vi } from 'vitest';
import { inCriticalSection, isInCriticalSection, whenNoCriticalSection } from '../../lib/critical-section';

// Applying an app update reloads every tab. It used to cut another tab's import
// (or force pull, or re-key) in half; it now waits for them, and holds new ones
// off until the reload.

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A minimal LockManager: shared holders run together, exclusive waits for all of them. */
function installFakeLocks() {
  const held: Array<'shared' | 'exclusive'> = [];
  const queue: Array<() => void> = [];
  const pump = () => {
    for (let i = 0; i < queue.length; i++) {
      const before = queue.length;
      queue[i]();
      if (queue.length < before) i--;
    }
  };
  const request = (_name: string, opts: { mode: 'shared' | 'exclusive' }, fn: () => Promise<unknown>) =>
    new Promise((resolve, reject) => {
      const attempt = () => {
        const free = opts.mode === 'shared' ? !held.includes('exclusive') : held.length === 0;
        if (!free) return;
        queue.splice(queue.indexOf(attempt), 1);
        held.push(opts.mode);
        Promise.resolve(fn()).then(resolve, reject).finally(() => {
          held.splice(held.indexOf(opts.mode), 1);
          pump();
        });
      };
      queue.push(attempt);
      pump();
    });
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  return { held };
}

afterEach(() => {
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
});

it('asks before the tab unloads while a section runs, and not after', async () => {
  const gate = deferred();
  const section = inCriticalSection(() => gate.promise);
  expect(isInCriticalSection()).toBe(true);
  const ev = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);

  gate.resolve();
  await section;
  expect(isInCriticalSection()).toBe(false);
  const after = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

it('an update waits for the running section (no Web Locks: this tab only)', async () => {
  vi.useFakeTimers();
  const gate = deferred();
  const section = inCriticalSection(() => gate.promise);
  const apply = vi.fn();
  const waiting = whenNoCriticalSection(apply);
  await vi.advanceTimersByTimeAsync(1000);
  expect(apply).not.toHaveBeenCalled();
  gate.resolve();
  await section;
  await vi.advanceTimersByTimeAsync(300);
  await waiting;
  expect(apply).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

it('with Web Locks, an update waits for every section and a new one waits for the reload', async () => {
  installFakeLocks();
  const gate = deferred();
  const running = inCriticalSection(() => gate.promise);
  const apply = vi.fn();
  await whenNoCriticalSection(apply);
  await Promise.resolve();
  expect(apply).not.toHaveBeenCalled();

  gate.resolve();
  await running;
  await new Promise((r) => setTimeout(r, 0));
  expect(apply).toHaveBeenCalledTimes(1);

  // Started after the update was applied: held off (the page is about to reload).
  const late = vi.fn(async () => {});
  void inCriticalSection(late);
  await new Promise((r) => setTimeout(r, 10));
  expect(late).not.toHaveBeenCalled();
});
