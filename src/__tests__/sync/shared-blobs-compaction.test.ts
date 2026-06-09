import { vi, type Mock } from 'vitest';

vi.mock('../../sync/github-api', () => ({
  getBinaryFile: vi.fn(),
  putBinaryFile: vi.fn(),
  getFileSha: vi.fn(),
  deleteFile: vi.fn(),
  getRef: vi.fn(),
  createRef: vi.fn(),
  updateRef: vi.fn(),
  getCommit: vi.fn(),
  getTree: vi.fn(),
  createTree: vi.fn(),
  createCommit: vi.fn(),
  createBlobBase64: vi.fn(),
}));

import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { setupSyncCredentials } from '../helpers/sync-helpers';
import * as gh from '../../sync/github-api';
import {
  compactBlobBranch, deleteSharedBlob, getSharedBlobBytes, maybeCompactBlobBranch, BLOB_BRANCH,
} from '../../sync/shared-blobs';
import { deriveKey, generateSalt, encryptBytes, cacheEncryptionKey, clearEncryptionKey } from '../../sync/crypto';

const KEEP = 'gtd25-shared/.gtd25-keep';
const entry = (path: string, sha: string) => ({ path, mode: '100644', type: 'blob' as const, sha });

const mGetRef = gh.getRef as Mock;
const mGetCommit = gh.getCommit as Mock;
const mGetTree = gh.getTree as Mock;
const mCreateTree = gh.createTree as Mock;
const mCreateCommit = gh.createCommit as Mock;
const mUpdateRef = gh.updateRef as Mock;
const mGetBinaryFile = gh.getBinaryFile as Mock;

const creds = { pat: 'p', repo: 'u/r' };

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  clearEncryptionKey();
});

describe('compactBlobBranch', () => {
  function tree(entries: ReturnType<typeof entry>[]) {
    mGetRef.mockResolvedValue('head1');
    mGetCommit.mockResolvedValue({ treeSha: 't1' });
    mGetTree.mockResolvedValue({ entries, truncated: false });
    mCreateTree.mockResolvedValue('t2');
    mCreateCommit.mockResolvedValue('c2');
    mUpdateRef.mockResolvedValue(undefined);
  }

  it('keeps only live blobs + the keep file, as an orphan commit force-pushed', async () => {
    tree([entry(KEEP, 'k'), entry('gtd25-shared/LIVE', 'l'), entry('gtd25-shared/DEAD', 'd')]);

    const dropped = await compactBlobBranch(creds, new Set(['LIVE']));
    expect(dropped).toBe(1);

    const keptPaths = (mCreateTree.mock.calls[0][2] as Array<{ path: string }>).map((e) => e.path).sort();
    expect(keptPaths).toEqual([KEEP, 'gtd25-shared/LIVE']);
    expect(mCreateCommit.mock.calls[0][2].parents).toEqual([]);
    expect(mUpdateRef).toHaveBeenCalledWith('p', 'u/r', BLOB_BRANCH, 'c2', true);
  });

  it('does nothing when there is no garbage', async () => {
    tree([entry(KEEP, 'k'), entry('gtd25-shared/LIVE', 'l')]);
    const dropped = await compactBlobBranch(creds, new Set(['LIVE']));
    expect(dropped).toBe(0);
    expect(mCreateTree).not.toHaveBeenCalled();
    expect(mUpdateRef).not.toHaveBeenCalled();
  });

  it('aborts the force-update if the branch moved during compaction', async () => {
    mGetRef.mockResolvedValueOnce('head1').mockResolvedValueOnce('head2');
    mGetCommit.mockResolvedValue({ treeSha: 't1' });
    mGetTree.mockResolvedValue({ entries: [entry(KEEP, 'k'), entry('gtd25-shared/DEAD', 'd')], truncated: false });
    mCreateTree.mockResolvedValue('t2');
    mCreateCommit.mockResolvedValue('c2');

    const dropped = await compactBlobBranch(creds, new Set());
    expect(dropped).toBe(0);
    expect(mUpdateRef).not.toHaveBeenCalled();
  });

  it('wipe (empty live set) collapses to just the keep file', async () => {
    tree([entry(KEEP, 'k'), entry('gtd25-shared/A', 'a'), entry('gtd25-shared/B', 'b')]);
    const dropped = await compactBlobBranch(creds, new Set());
    expect(dropped).toBe(2);
    const keptPaths = (mCreateTree.mock.calls[0][2] as Array<{ path: string }>).map((e) => e.path);
    expect(keptPaths).toEqual([KEEP]);
    expect(mUpdateRef).toHaveBeenCalled();
  });

  it('returns 0 when the branch does not exist', async () => {
    mGetRef.mockResolvedValue(null);
    expect(await compactBlobBranch(creds, new Set())).toBe(0);
    expect(mGetTree).not.toHaveBeenCalled();
  });
});

describe('deleteSharedBlob', () => {
  it('increments syncMeta.pendingBlobDeletes (the compaction gate)', async () => {
    await deleteSharedBlob('X'); // no creds configured -> remote no-op, but counter bumps
    await deleteSharedBlob('Y');
    const meta = await db.syncMeta.get('sync-meta');
    expect(meta?.pendingBlobDeletes).toBe(2);
  });
});

describe('getSharedBlobBytes legacy fallback', () => {
  it('falls back to the default branch when the blob is not on the blob branch', async () => {
    await setupSyncCredentials();
    const key = await deriveKey('pw', generateSalt());
    cacheEncryptionKey(key, 'salt');
    const plaintext = new Uint8Array([5, 6, 7]);
    const ciphertext = await encryptBytes(key, plaintext);

    // First call (ref = blob branch) misses; second call (default branch) hits.
    mGetBinaryFile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ciphertext);

    const out = await getSharedBlobBytes('legacy-id');
    expect(Array.from(out)).toEqual([5, 6, 7]);
    // Branch attempt passed the ref; fallback omitted it.
    expect(mGetBinaryFile.mock.calls[0][4]).toBe(BLOB_BRANCH);
    expect(mGetBinaryFile.mock.calls[1][4]).toBeUndefined();
  });
});

describe('maybeCompactBlobBranch gate', () => {
  it('skips when there are no pending deletes and the interval has not elapsed', async () => {
    await db.syncMeta.update('sync-meta', { pendingBlobDeletes: 0, lastBlobCompactionAt: Date.now() });
    await maybeCompactBlobBranch('p', 'u/r');
    expect(mGetRef).not.toHaveBeenCalled();
  });

  it('runs and resets the counter when deletes are pending', async () => {
    await db.syncMeta.update('sync-meta', { pendingBlobDeletes: 3, lastBlobCompactionAt: 0 });
    mGetRef.mockResolvedValue(null); // branch absent -> compaction is a no-op
    await maybeCompactBlobBranch('p', 'u/r');
    expect(mGetRef).toHaveBeenCalled();
    const meta = await db.syncMeta.get('sync-meta');
    expect(meta?.pendingBlobDeletes).toBe(0);
    expect(meta?.lastBlobCompactionAt).toBeGreaterThan(0);
  });
});
