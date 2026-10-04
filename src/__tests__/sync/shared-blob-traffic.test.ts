import { vi, type Mock } from 'vitest';

// Every github-api call goes to an in-memory repository, wrapped in a spy so a
// test can say which requests a Shared Folder action makes — or that it makes none.
vi.mock('../../sync/github-api', async () => {
  const { fakeGitHubApi } = await import('../helpers/fake-repo');
  return Object.fromEntries(Object.entries(fakeGitHubApi).map(([name, value]) =>
    [name, typeof value === 'function' && name !== 'RateLimitError' ? vi.fn(value) : value]));
});
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

import * as api from '../../sync/github-api';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials } from '../helpers/sync-helpers';
import { fakeRepo } from '../helpers/fake-repo';
import { deriveKey, generateSalt, cacheEncryptionKey } from '../../sync/crypto';
import {
  sharedBlobBlocker, canUploadSharedBlob, uploadSharedBlob, getSharedBlobBytes, blobPath, BLOB_BRANCH,
} from '../../sync/shared-blobs';

const apiCalls = () => Object.entries(api)
  .filter(([, fn]) => typeof fn === 'function' && 'mock' in fn)
  .flatMap(([name, fn]) => (fn as Mock).mock.calls.map(() => name));

beforeEach(async () => {
  await resetSyncState();
  fakeRepo.reset();
  vi.clearAllMocks();
  const salt = generateSalt();
  cacheEncryptionKey(await deriveKey('sync password', salt), salt);
});

describe('Shared Folder with sync switched off', () => {
  // Turning sync off is the user's way of keeping this device quiet on the
  // network. The folder used to keep uploading, downloading and deleting files
  // anyway, because it read the token without asking whether sync was on.
  beforeEach(async () => {
    await setupSyncCredentials({ syncEnabled: false });
  });

  it('reports that sync is not set up, so nothing can be added', async () => {
    expect(await sharedBlobBlocker()).toBe('no-sync');
    expect(await canUploadSharedBlob()).toBe(false);
  });

  it('refuses an upload without a request', async () => {
    await expect(uploadSharedBlob('b1', new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect(apiCalls()).toEqual([]);
    expect(fakeRepo.listPaths(BLOB_BRANCH)).toEqual([]);
  });

  it('opens a cached file but downloads nothing', async () => {
    await db.sharedBlobs.put({ id: 'cached', data: new Uint8Array([7, 8, 9]), cachedAt: 1 });
    expect(Array.from(await getSharedBlobBytes('cached'))).toEqual([7, 8, 9]);

    fakeRepo.writeBytes(blobPath('remote-only'), new Uint8Array(40), BLOB_BRANCH);
    vi.clearAllMocks();
    await expect(getSharedBlobBytes('remote-only')).rejects.toThrow();
    expect(apiCalls()).toEqual([]);
  });

  it('uploads again once sync is back on', async () => {
    await db.localSettings.update('local', { syncEnabled: true });
    expect(await sharedBlobBlocker()).toBeNull();
    await uploadSharedBlob('b1', new Uint8Array([1, 2, 3]));
    expect(fakeRepo.listPaths(BLOB_BRANCH)).toContain(blobPath('b1'));
  });
});
