import { vi } from 'vitest';

// Reliability review 2026-10-05, Shared Folder: a transient failure creating the
// blob branch passed for "another device made it", and a full disk failing the
// local cache write failed an upload that had already reached GitHub.

vi.mock('../../sync/github-api', async () => (await import('../helpers/fake-repo')).fakeGitHubApi);

import { db } from '../../db';
import { fakeRepo } from '../helpers/fake-repo';
import { resetSyncState, setupSyncCredentials } from '../helpers/sync-helpers';
import { ensureBlobBranch, uploadSharedBlob, BLOB_BRANCH, blobPath, __resetBlobBranchEnsuredForTests } from '../../sync/shared-blobs';
import { cacheEncryptionKey, deriveKey, generateSalt } from '../../sync/crypto';

const creds = { pat: 'ghp_test123', repo: 'user/repo' };

beforeEach(async () => {
  await resetSyncState();
  await setupSyncCredentials();
  fakeRepo.reset();
  __resetBlobBranchEnsuredForTests();
  const salt = generateSalt();
  cacheEncryptionKey(await deriveKey('test-password', salt), salt);
});

afterEach(() => vi.restoreAllMocks());

it('a failed branch creation is not taken for "it exists": it throws, and the next call tries again', async () => {
  vi.spyOn(fakeRepo.api, 'createRef').mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await expect(ensureBlobBranch(creds)).rejects.toThrow('Failed to fetch');
  expect(fakeRepo.refs.has(BLOB_BRANCH)).toBe(false);

  await ensureBlobBranch(creds);
  expect(fakeRepo.refs.has(BLOB_BRANCH)).toBe(true);
});

it('another device creating the branch first is still fine', async () => {
  vi.spyOn(fakeRepo.api, 'createRef').mockImplementationOnce(async (_p, _r, branch, sha) => {
    fakeRepo.refs.set(branch, sha); // it won the race…
    throw new Error('GitHub API error (createRef): 422'); // …so ours is refused
  });
  await expect(ensureBlobBranch(creds)).resolves.toBeUndefined();
});

it('an upload that reached GitHub succeeds even when the local cache cannot be written', async () => {
  vi.spyOn(db.sharedBlobs, 'put').mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
  await expect(uploadSharedBlob('b1', new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
  expect(fakeRepo.readBytes(blobPath('b1'), BLOB_BRANCH)).not.toBeNull();
});
