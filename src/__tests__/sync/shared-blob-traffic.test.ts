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
  sharedBlobBlocker, canUploadSharedBlob, uploadSharedBlob, getSharedBlobBytes, blobPath, BLOB_BRANCH, KEEP_PATH,
  maybeCompactBlobBranch,
} from '../../sync/shared-blobs';
import { createFileItem, deleteSharedItem, deleteAllSharedItems } from '../../hooks/use-shared-items';
import { purgeOldTrashItems } from '../../db/purge';

const PAT = 'ghp_test123';
const REPO = 'user/repo';
const files = () => fakeRepo.listPaths(BLOB_BRANCH).filter((p) => p !== KEEP_PATH);
// Lets any fire-and-forget request a delete might start reach the repository.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

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

describe('Deleting shared files', () => {
  // A delete used to remove the file from the branch tip with its own request
  // (GET for the sha — which for files up to 1 MB returns the whole ciphertext —
  // then DELETE), after which compaction found nothing at the tip to drop and
  // never squashed: the deleted bytes stayed reachable in the branch history for
  // anyone holding the token. Now a delete is local, and the compaction after the
  // next sync rebuilds the branch without the file, history included.
  beforeEach(async () => {
    await setupSyncCredentials();
  });

  async function addFile(name: string, text: string) {
    const item = await createFileItem(new File([text], name, { type: 'text/plain' }));
    expect(item?.blobId).toBeDefined();
    return item!;
  }

  it('makes no request by itself, and the next compaction takes the file out of the history', async () => {
    const kept = await addFile('kept.txt', 'stays');
    const gone = await addFile('gone.txt', 'goes');
    expect(fakeRepo.historyLength(BLOB_BRANCH)).toBeGreaterThan(1);

    vi.clearAllMocks();
    await deleteSharedItem(gone.id);
    await settle();
    expect(apiCalls()).toEqual([]);
    expect(await db.sharedBlobs.get(gone.blobId!)).toBeUndefined();

    await maybeCompactBlobBranch(PAT, REPO);
    expect(files()).toEqual([blobPath(kept.blobId!)]);
    expect(fakeRepo.historyLength(BLOB_BRANCH)).toBe(1);
    expect((await db.syncMeta.get('sync-meta'))?.pendingBlobDeletes).toBe(0);
  });

  it('empties the folder with one rewrite of the branch, not a request per file', async () => {
    for (const n of ['a', 'b', 'c']) await addFile(`${n}.txt`, n);
    vi.clearAllMocks();

    expect(await deleteAllSharedItems()).toBe(3);
    await settle();
    expect(apiCalls()).toEqual([]);

    await maybeCompactBlobBranch(PAT, REPO);
    expect(files()).toEqual([]);
    expect(fakeRepo.historyLength(BLOB_BRANCH)).toBe(1);
    expect((api.updateRef as Mock).mock.calls).toHaveLength(1);
    expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('squashes the history an older version left behind with its per-file deletes', async () => {
    const kept = await addFile('kept.txt', 'stays');
    const gone = await addFile('gone.txt', 'goes');
    // What an older build did: tombstone, then remove the file at the tip only.
    await db.sharedItems.update(gone.id, { deletedAt: Date.now() });
    fakeRepo.remove(blobPath(gone.blobId!), BLOB_BRANCH);
    await db.syncMeta.update('sync-meta', { pendingBlobDeletes: 0, lastBlobCompactionAt: 0 });

    await maybeCompactBlobBranch(PAT, REPO);
    expect(files()).toEqual([blobPath(kept.blobId!)]);
    expect(fakeRepo.historyLength(BLOB_BRANCH)).toBe(1);
  });

  it('purging an old tombstone makes no request', async () => {
    const gone = await addFile('gone.txt', 'goes');
    const longAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await db.sharedItems.update(gone.id, { deletedAt: longAgo, updatedAt: longAgo });
    vi.clearAllMocks();

    await purgeOldTrashItems();
    expect(await db.sharedItems.get(gone.id)).toBeUndefined();
    expect(await db.sharedBlobs.get(gone.blobId!)).toBeUndefined();
    expect(apiCalls()).toEqual([]);
  });
});
