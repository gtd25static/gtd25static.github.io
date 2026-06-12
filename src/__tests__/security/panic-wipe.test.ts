import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { panicWipe, retryPendingWipe, WIPE_PENDING_KEY } from '../../lib/panic-wipe';
import { __resetVaultStateForTests } from '../../db/vault';
import type { Task } from '../../db/models';

interface MutableGlobal {
  caches?: unknown;
  sessionStorage?: unknown;
}

function seedTask() {
  const now = Date.now();
  return db.tasks.add({ id: 't1', listId: 'l1', title: 'secret', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
}

let savedNav: PropertyDescriptor | undefined;

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.clear();
  savedNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.clear();
  const g = globalThis as MutableGlobal;
  delete g.caches;
  delete g.sessionStorage;
  if (savedNav) Object.defineProperty(globalThis, 'navigator', savedNav);
  vi.restoreAllMocks();
});

describe('panicWipe', () => {
  it('erases IndexedDB, gtd25 localStorage, sessionStorage, caches and the service worker', async () => {
    await seedTask();
    localStorage.setItem('gtd25-paranoid', '1');
    localStorage.setItem('gtd25-settings', '{}');
    localStorage.setItem('other-app', 'keep me');

    const g = globalThis as MutableGlobal;
    const sessionClear = vi.fn();
    g.sessionStorage = { clear: sessionClear };
    const cacheDelete = vi.fn().mockResolvedValue(true);
    g.caches = { keys: vi.fn().mockResolvedValue(['workbox-precache-v2', 'gtd25-runtime']), delete: cacheDelete };
    const unregister = vi.fn().mockResolvedValue(true);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) } },
    });

    await panicWipe({ reload: false });

    await db.open(); // panicWipe closes the DB; reopen to inspect it's empty
    expect(await db.tasks.count()).toBe(0);
    expect(localStorage.getItem('gtd25-paranoid')).toBeNull();
    expect(localStorage.getItem('gtd25-settings')).toBeNull();
    expect(localStorage.getItem('other-app')).toBe('keep me'); // non-gtd25 keys survive
    expect(sessionClear).toHaveBeenCalled();
    expect(cacheDelete).toHaveBeenCalledWith('workbox-precache-v2');
    expect(cacheDelete).toHaveBeenCalledWith('gtd25-runtime');
    expect(unregister).toHaveBeenCalled();
  });

  it('completes without throwing when caches / service worker are unavailable', async () => {
    await seedTask();
    localStorage.setItem('gtd25-foo', 'x');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });

    await expect(panicWipe({ reload: false })).resolves.toBeUndefined();

    await db.open();
    expect(await db.tasks.count()).toBe(0);
    expect(localStorage.getItem('gtd25-foo')).toBeNull();
  });

  it('clears the wipe-pending marker once IndexedDB deletion is confirmed', async () => {
    await seedTask();

    await panicWipe({ reload: false });

    expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull();
  });
});

describe('blocked wipe + boot retry', () => {
  /** Make the next deleteDatabase call report BLOCKED (a second tab holds the DB). */
  function stubBlockedDeleteOnce() {
    return vi.spyOn(indexedDB, 'deleteDatabase').mockImplementationOnce(() => {
      const req = { onsuccess: null, onerror: null, onblocked: null } as unknown as IDBOpenDBRequest;
      setTimeout(() => req.onblocked?.(new Event('blocked') as IDBVersionChangeEvent), 0);
      return req;
    });
  }

  it('keeps the wipe-pending marker (surviving the storage clear) when deletion is blocked', async () => {
    await seedTask();
    localStorage.setItem('gtd25-foo', 'x');
    stubBlockedDeleteOnce();

    await panicWipe({ reload: false });

    expect(localStorage.getItem(WIPE_PENDING_KEY)).not.toBeNull();
    expect(localStorage.getItem('gtd25-foo')).toBeNull(); // other gtd25 keys still cleared
  });

  it('retryPendingWipe finishes a previously blocked wipe and clears the marker', async () => {
    await seedTask();
    stubBlockedDeleteOnce();
    await panicWipe({ reload: false });
    expect(localStorage.getItem(WIPE_PENDING_KEY)).not.toBeNull();
    await db.open();
    expect(await db.tasks.count()).toBe(1); // blocked: data survived the first attempt

    await retryPendingWipe(); // unstubbed → deletion succeeds this time

    expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull();
    await db.open();
    expect(await db.tasks.count()).toBe(0);
  });

  it('retryPendingWipe is a no-op without the marker', async () => {
    await seedTask();
    const deleteSpy = vi.spyOn(indexedDB, 'deleteDatabase');

    await retryPendingWipe();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await db.tasks.count()).toBe(1);
  });
});
