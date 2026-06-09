import { vi, type Mock } from 'vitest';

vi.mock('../../sync/github-api', () => ({
  getDefaultBranch: vi.fn(),
  getRef: vi.fn(),
  getCommit: vi.fn(),
  createCommit: vi.fn(),
  updateRef: vi.fn(),
}));

import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import * as gh from '../../sync/github-api';
import { squashDefaultBranch, maybeSquashDefaultBranch } from '../../sync/history-compaction';

const mGetDefaultBranch = gh.getDefaultBranch as Mock;
const mGetRef = gh.getRef as Mock;
const mGetCommit = gh.getCommit as Mock;
const mCreateCommit = gh.createCommit as Mock;
const mUpdateRef = gh.updateRef as Mock;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  mGetDefaultBranch.mockResolvedValue('main');
});

describe('squashDefaultBranch', () => {
  it('rewrites a multi-commit branch to a single orphan commit holding the same tree', async () => {
    mGetRef.mockResolvedValue('head1');
    mGetCommit.mockResolvedValue({ treeSha: 'tree1', parents: ['p1'] });
    mCreateCommit.mockResolvedValue('commit2');
    mUpdateRef.mockResolvedValue(undefined);

    expect(await squashDefaultBranch('pat', 'u/r')).toBe(true);
    // Orphan commit reusing the existing tree
    expect(mCreateCommit).toHaveBeenCalledWith('pat', 'u/r', { message: 'gtd25: compact history', tree: 'tree1', parents: [] });
    expect(mUpdateRef).toHaveBeenCalledWith('pat', 'u/r', 'main', 'commit2', true);
  });

  it('skips when the branch is already a single root commit', async () => {
    mGetRef.mockResolvedValue('head1');
    mGetCommit.mockResolvedValue({ treeSha: 'tree1', parents: [] });
    expect(await squashDefaultBranch('pat', 'u/r')).toBe(false);
    expect(mCreateCommit).not.toHaveBeenCalled();
    expect(mUpdateRef).not.toHaveBeenCalled();
  });

  it('aborts the force-update if the branch moved during compaction', async () => {
    mGetRef.mockResolvedValueOnce('head1').mockResolvedValueOnce('head2');
    mGetCommit.mockResolvedValue({ treeSha: 'tree1', parents: ['p1'] });
    mCreateCommit.mockResolvedValue('commit2');
    expect(await squashDefaultBranch('pat', 'u/r')).toBe(false);
    expect(mUpdateRef).not.toHaveBeenCalled();
  });

  it('returns false when the branch has no head', async () => {
    mGetRef.mockResolvedValue(null);
    expect(await squashDefaultBranch('pat', 'u/r')).toBe(false);
    expect(mGetCommit).not.toHaveBeenCalled();
  });
});

describe('maybeSquashDefaultBranch gate', () => {
  it('only arms the clock on the first call (no squash on a fresh repo)', async () => {
    await maybeSquashDefaultBranch('pat', 'u/r');
    expect(mGetRef).not.toHaveBeenCalled();
    const meta = await db.syncMeta.get('sync-meta');
    expect(meta?.lastMainSquashAt).toBeGreaterThan(0);
  });

  it('skips while within the interval', async () => {
    await db.syncMeta.update('sync-meta', { lastMainSquashAt: Date.now() - 5 * DAY });
    await maybeSquashDefaultBranch('pat', 'u/r');
    expect(mGetRef).not.toHaveBeenCalled();
  });

  it('squashes and restamps once the interval has elapsed', async () => {
    await db.syncMeta.update('sync-meta', { lastMainSquashAt: Date.now() - 40 * DAY });
    mGetRef.mockResolvedValue('head1');
    mGetCommit.mockResolvedValue({ treeSha: 'tree1', parents: ['p1'] });
    mCreateCommit.mockResolvedValue('commit2');
    mUpdateRef.mockResolvedValue(undefined);

    await maybeSquashDefaultBranch('pat', 'u/r');
    expect(mUpdateRef).toHaveBeenCalled();
    const meta = await db.syncMeta.get('sync-meta');
    expect(Date.now() - (meta?.lastMainSquashAt ?? 0)).toBeLessThan(DAY);
  });
});
