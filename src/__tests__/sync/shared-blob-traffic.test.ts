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

describe('Compaction keeps what it cannot account for', () => {
  // The compaction keeps only blobs this device knows to be live and drops the
  // rest. It used to treat every blob it could not match to a readable item as
  // garbage — so a row it could not decrypt, or another device's upload whose
  // metadata had not arrived yet, lost its file for good.
  beforeEach(async () => {
    await setupSyncCredentials();
  });

  async function addFile(name: string, text: string) {
    const item = await createFileItem(new File([text], name, { type: 'text/plain' }));
    expect(item?.blobId).toBeDefined();
    return item!;
  }

  async function dueRun(meta: Record<string, unknown> = {}) {
    await db.syncMeta.update('sync-meta', { pendingBlobDeletes: 1, lastBlobCompactionAt: 0, ...meta });
    vi.clearAllMocks();
    await maybeCompactBlobBranch(PAT, REPO);
  }

  it('does nothing while an item row cannot be read', async () => {
    const kept = await addFile('kept.txt', 'stays');
    // What a locked vault or a failed decrypt hands back: no blobId to match.
    await db.sharedItems.update(kept.id, { _decryptError: true, blobId: undefined } as never);
    await dueRun();
    expect(files()).toEqual([blobPath(kept.blobId!)]);
    expect(api.updateRef).not.toHaveBeenCalled();
  });

  it('does nothing — not even a request — while the vault is locked', async () => {
    const kept = await addFile('kept.txt', 'stays');
    localStorage.setItem('gtd25-paranoid', '1'); // Paranoid, and no key in hand
    try {
      await dueRun();
    } finally {
      localStorage.removeItem('gtd25-paranoid');
    }
    expect(apiCalls()).toEqual([]);
    expect(files()).toEqual([blobPath(kept.blobId!)]);
  });

  it("keeps another device's new file until its metadata could have arrived", async () => {
    await addFile('mine.txt', 'mine');
    fakeRepo.writeBytes(blobPath('theirs'), new Uint8Array(40), BLOB_BRANCH); // no item here yet
    const start = Date.now();

    await dueRun();
    expect(files()).toContain(blobPath('theirs'));

    vi.spyOn(Date, 'now').mockReturnValue(start + 24 * 60 * 60 * 1000);
    await dueRun();
    expect(files()).toContain(blobPath('theirs'));

    vi.spyOn(Date, 'now').mockReturnValue(start + 8 * 24 * 60 * 60 * 1000);
    await dueRun();
    expect(files()).not.toContain(blobPath('theirs'));
  });

  it('drops a file deleted here at once', async () => {
    const gone = await addFile('gone.txt', 'goes');
    await deleteSharedItem(gone.id);
    await maybeCompactBlobBranch(PAT, REPO);
    expect(files()).toEqual([]);
  });

  it('does not rewrite the branch on a routine run with nothing to drop', async () => {
    // Every rewrite is a forced ref update that an upload landing at the same
    // moment can lose to; the routine 6-hour run used to make one whenever the
    // branch had any history — that is, after every upload.
    await addFile('a.txt', 'a');
    await db.syncMeta.update('sync-meta', { blobHistorySweptAt: 1 });
    await addFile('b.txt', 'b');
    expect(fakeRepo.historyLength(BLOB_BRANCH)).toBeGreaterThan(1);

    await dueRun({ pendingBlobDeletes: 0, blobHistorySweptAt: 1 });
    expect(api.updateRef).not.toHaveBeenCalled();
  });

  it('backs off after a failed run instead of retrying on every sync', async () => {
    const gone = await addFile('gone.txt', 'goes');
    await deleteSharedItem(gone.id);
    vi.mocked(api.updateRef).mockRejectedValueOnce(new Error('GitHub API error (updateRef): 422'));
    await expect(maybeCompactBlobBranch(PAT, REPO)).rejects.toThrow(/422/);

    vi.clearAllMocks();
    await maybeCompactBlobBranch(PAT, REPO);
    expect(apiCalls()).toEqual([]);
    expect((await db.syncMeta.get('sync-meta'))?.pendingBlobDeletes).toBe(1);
  });
});

