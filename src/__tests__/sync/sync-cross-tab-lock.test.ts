import { vi } from 'vitest';
import { resetSyncState, setupSyncCredentials } from '../helpers/sync-helpers';

vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  return { ...actual, getFile: vi.fn(), putFile: vi.fn(), deleteFile: vi.fn(), testConnection: vi.fn() };
});
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

import { getFile } from '../../sync/github-api';
import { syncNow } from '../../sync/sync-engine';

type LockCallback = (lock: object | null) => Promise<number>;
interface RequestCall { name: string; options: { ifAvailable?: boolean } }

/**
 * Stand in for the Web Locks API. `available: false` is what a second tab
 * mid-sync looks like: the browser invokes the callback with null.
 */
function stubLocks(available: boolean): RequestCall[] {
  const calls: RequestCall[] = [];
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, options: { ifAvailable?: boolean }, cb: LockCallback) => {
        calls.push({ name, options });
        return cb(available ? { name } : null);
      },
    },
  });
  return calls;
}

beforeEach(async () => {
  await resetSyncState();
  vi.clearAllMocks();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks');
});

describe('syncNow — one sync at a time across tabs', () => {
  it('skips entirely while another tab holds the lock', async () => {
    await setupSyncCredentials();
    const calls = stubLocks(false);

    expect(await syncNow()).toBe(-1);
    // Not a single request went out: the other tab pushes our changes for us,
    // since the pending changelog is the same shared IndexedDB table.
    expect(getFile).not.toHaveBeenCalled();
    expect(calls).toEqual([{ name: 'gtd25-sync', options: { ifAvailable: true } }]);
  });

  it('runs when the lock is free', async () => {
    await setupSyncCredentials();
    stubLocks(true);

    await syncNow();
    expect(getFile).toHaveBeenCalled();
  });

  it('still syncs where Web Locks are unavailable', async () => {
    // Falls back to the per-tab lock — the behaviour before this existed.
    await setupSyncCredentials();
    Reflect.deleteProperty(navigator, 'locks');

    await syncNow();
    expect(getFile).toHaveBeenCalled();
  });
});
