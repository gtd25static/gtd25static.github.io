import { vi, type Mock, describe, it, expect, beforeEach } from 'vitest';
import { resetSyncState, setupSyncCredentials } from '../helpers/sync-helpers';

// Mock only the conditional GET (the probe's network call) and pendingEntryCount.
vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  return { ...actual, getFileConditional: vi.fn() };
});
vi.mock('../../sync/change-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/change-log')>();
  return { ...actual, pendingEntryCount: vi.fn() };
});
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

import { getFileConditional } from '../../sync/github-api';
import { pendingEntryCount } from '../../sync/change-log';
import { cheapIdleProbe } from '../../sync/sync-engine';

const mockCond = getFileConditional as Mock;
const mockPending = pendingEntryCount as Mock;

beforeEach(async () => {
  await resetSyncState();
  vi.clearAllMocks();
  mockPending.mockResolvedValue(0);
});

describe('cheapIdleProbe (Paranoid idle poll gate)', () => {
  it('returns false (skip full sync) when both files are unchanged and nothing is pending', async () => {
    await setupSyncCredentials();
    mockCond.mockResolvedValue({ status: 'unchanged', etag: 'W/"x"' });
    expect(await cheapIdleProbe()).toBe(false);
    expect(mockCond).toHaveBeenCalledTimes(2); // changelog + snapshot
  });

  it('returns true (do the full sync) when the changelog changed', async () => {
    await setupSyncCredentials();
    mockCond.mockImplementation((_pat: string, _repo: string, path: string) =>
      Promise.resolve(
        path.includes('changelog')
          ? { status: 'ok', data: '[]', sha: 's', etag: 'W/"new"' }
          : { status: 'unchanged', etag: 'W/"x"' },
      ),
    );
    expect(await cheapIdleProbe()).toBe(true);
  });

  it('returns true without probing when there are pending local changes', async () => {
    await setupSyncCredentials();
    mockPending.mockResolvedValue(3);
    expect(await cheapIdleProbe()).toBe(true);
    expect(mockCond).not.toHaveBeenCalled();
  });

  it('returns false without probing when sync is not configured', async () => {
    // no setupSyncCredentials -> getCredentials returns null
    expect(await cheapIdleProbe()).toBe(false);
    expect(mockCond).not.toHaveBeenCalled();
  });

  it('falls through to a full sync on any probe error', async () => {
    await setupSyncCredentials();
    mockCond.mockRejectedValue(new Error('network'));
    expect(await cheapIdleProbe()).toBe(true);
  });
});
