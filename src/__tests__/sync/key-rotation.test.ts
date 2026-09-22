import { vi, type Mock } from 'vitest';
// Real PBKDF2 (600k iterations) for two passwords, several times per test.
vi.setConfig({ testTimeout: 120_000 });

vi.mock('../../sync/github-api', async () => (await import('../helpers/fake-repo')).fakeGitHubApi);
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../sync/sync-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/sync-engine')>();
  return { ...actual, syncNow: vi.fn(async () => 0), endSyncSession: vi.fn() };
});

import { db } from '../../db';
import type { SyncData, TaskList, Task } from '../../db/models';
import { resetSyncState, setupSyncCredentials, makeSharedItem, makeChangeEntry } from '../helpers/sync-helpers';
import { fakeRepo } from '../helpers/fake-repo';
import { rotateSyncKey, hasUnfinishedRotation, discardUnfinishedRotation } from '../../sync/key-rotation';
import {
  deriveKey, generateSalt, createVerifier, checkVerifier, encryptBytes, decryptBytes,
  encryptSyncData, decryptSyncData, cacheEncryptionKey, getCachedSalt,
} from '../../sync/crypto';
import { syncNow, endSyncSession, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { BLOB_BRANCH, KEEP_PATH, blobPath } from '../../sync/shared-blobs';
import { BACKUP_FILES } from '../../sync/remote-backups';
import { publishOwnRegistryEntry, readAuthenticRegistry } from '../../sync/remote-unlock';
import { deriveRegistryMacKey } from '../../sync/remote-unlock-crypto';
import { SYNC_VERSION } from '../../sync/version';

// Changing the sync password rotates everything in the repo that the old key
// covered — snapshot, changelog, every shared file, the backups, the registry —
// and can be resumed from any interruption.

const OLD_PW = 'old sync password one';
const NEW_PW = 'new sync password two';
const OTHER_PW = 'a third password nobody chose';
const PAT = 'ghp_test123';
const REPO = 'user/repo';
const PLAIN = {
  b1: new TextEncoder().encode('FILE_ONE_BYTES'),
  b2: new TextEncoder().encode('FILE_TWO_BYTES'),
  b3: new TextEncoder().encode('LEGACY_FILE_BYTES'),
};
const MIGRATION_BACKUP = `gtd25-snapshot-v${SYNC_VERSION - 1}.backup.json`;

let oldKey: CryptoKey;
let oldSalt: string;

const mockSyncNow = syncNow as Mock;
const mockEndSyncSession = endSyncSession as Mock;

async function seed(opts: { unreadableB2?: boolean } = {}) {
  await setupSyncCredentials({ encryptionPassword: OLD_PW });
  oldSalt = generateSalt();
  oldKey = await deriveKey(OLD_PW, oldSalt);
  cacheEncryptionKey(oldKey, oldSalt);

  const list = { id: 'l1', name: 'LIST_NAME', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList;
  const task = { id: 't1', listId: 'l1', title: 'TASK_TITLE', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task;
  const items = (['b1', 'b2', 'b3'] as const).map((blobId, i) =>
    makeSharedItem({ id: `si-${blobId}`, type: 'file', name: `${blobId}.txt`, blobId, mimeType: 'text/plain', order: i }));
  await db.taskLists.add(list);
  await db.tasks.add(task);
  await db.sharedItems.bulkAdd(items);

  const plain: SyncData = {
    syncVersion: SYNC_VERSION, encryptionSalt: oldSalt, encryptionVerifier: await createVerifier(oldKey),
    taskLists: [list], tasks: [task], subtasks: [], sharedItems: items,
    mindmapFolders: [], mindmaps: [], mindmapNodes: [], settings: { theme: 'system' },
  };
  const snapshotJson = JSON.stringify(await encryptSyncData(oldKey, plain));
  fakeRepo.writeText(SNAPSHOT_FILE, snapshotJson);
  fakeRepo.writeText(CHANGELOG_FILE, '[]');
  fakeRepo.writeText(SNAPSHOT_FILE, snapshotJson); // a second commit: history worth squashing
  fakeRepo.writeText(MIGRATION_BACKUP, snapshotJson);
  for (const tier of Object.values(BACKUP_FILES)) {
    fakeRepo.writeText(tier, JSON.stringify({ ...JSON.parse(snapshotJson), backedUpAt: 1 }));
  }
  fakeRepo.writeBytes(KEEP_PATH, new TextEncoder().encode('gtd25 shared folder blobs'), BLOB_BRANCH);
  fakeRepo.writeBytes(blobPath('b1'), await encryptBytes(oldKey, PLAIN.b1), BLOB_BRANCH);
  fakeRepo.writeBytes(blobPath('b2'), opts.unreadableB2 ? crypto.getRandomValues(new Uint8Array(40)) : await encryptBytes(oldKey, PLAIN.b2), BLOB_BRANCH);
  fakeRepo.writeBytes(blobPath('b3'), await encryptBytes(oldKey, PLAIN.b3)); // before blobs had a branch
  expect(await publishOwnRegistryEntry()).toBe(true); // under the old MAC
}

async function newKeyFromRemote(): Promise<{ key: CryptoKey; salt: string }> {
  const salt = (JSON.parse(fakeRepo.readText(SNAPSHOT_FILE)!) as SyncData).encryptionSalt!;
  return { key: await deriveKey(NEW_PW, salt), salt };
}

function remoteState(): string {
  return JSON.stringify({
    main: fakeRepo.listPaths().map((p) => [p, fakeRepo.sha(p)]),
    blobs: fakeRepo.listPaths(BLOB_BRANCH).map((p) => [p, fakeRepo.sha(p, BLOB_BRANCH)]),
    refs: [...fakeRepo.refs],
  });
}

beforeEach(async () => {
  await resetSyncState();
  fakeRepo.reset();
  vi.clearAllMocks();
  mockSyncNow.mockResolvedValue(0);
  for (const tier of Object.keys(BACKUP_FILES)) localStorage.removeItem(`gtd25-backup-${tier}-at`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rotateSyncKey rotates the whole repo', () => {
  it('rewrites every live shared file under the new key as one root commit, and moves the legacy one', async () => {
    await seed();
    const result = await rotateSyncKey(NEW_PW);
    const { key: newKey } = await newKeyFromRemote();

    for (const [blobId, plain] of Object.entries(PLAIN)) {
      const bytes = fakeRepo.readBytes(blobPath(blobId), BLOB_BRANCH);
      expect(bytes, `${blobId} on the blob branch`).not.toBeNull();
      expect(await decryptBytes(newKey, bytes!)).toEqual(plain);
      await expect(decryptBytes(oldKey, bytes!)).rejects.toBeTruthy();
    }
    expect(fakeRepo.historyLength(BLOB_BRANCH)).toBe(1);
    expect(fakeRepo.readBytes(blobPath('b3'))).toBeNull(); // gone from the default branch
    expect(result).toEqual({ blobsRewritten: 3, blobsUnreadable: 0, historySquashed: true });
  });

  it('rewrites the snapshot with a new salt and verifier, and empties the changelog', async () => {
    await seed();
    await rotateSyncKey(NEW_PW);
    const { key: newKey, salt } = await newKeyFromRemote();
    const snapshot = JSON.parse(fakeRepo.readText(SNAPSHOT_FILE)!) as SyncData;

    expect(salt).not.toBe(oldSalt);
    expect(await checkVerifier(newKey, snapshot.encryptionVerifier!)).toBe(true);
    expect(await checkVerifier(oldKey, snapshot.encryptionVerifier!)).toBe(false);
    expect((await decryptSyncData(newKey, snapshot)).tasks[0].title).toBe('TASK_TITLE');
    expect(fakeRepo.readText(CHANGELOG_FILE)).toBe('[]');
  });

  it('drops the migration backups and writes none under the old key', async () => {
    await seed();
    await rotateSyncKey(NEW_PW);
    for (let v = 0; v <= SYNC_VERSION; v++) {
      expect(fakeRepo.sha(`gtd25-snapshot-v${v}.backup.json`), `v${v} backup`).toBeNull();
    }
  });

  it('rewrites the three tier backups under the new key', async () => {
    await seed();
    const started = Date.now();
    await rotateSyncKey(NEW_PW);
    const { key: newKey, salt } = await newKeyFromRemote();
    for (const [tier, path] of Object.entries(BACKUP_FILES)) {
      const backup = JSON.parse(fakeRepo.readText(path)!) as SyncData & { backedUpAt: number };
      expect(backup.encryptionSalt, tier).toBe(salt);
      expect(backup.backedUpAt).toBeGreaterThanOrEqual(started);
      expect((await decryptSyncData(newKey, backup)).tasks[0].title).toBe('TASK_TITLE');
      expect(Number(localStorage.getItem(`gtd25-backup-${tier}-at`))).toBe(backup.backedUpAt);
    }
  });

  it("re-MACs this device's registry entry under the new key", async () => {
    await seed();
    await rotateSyncKey(NEW_PW);
    const { salt } = await newKeyFromRemote();
    const underNew = await readAuthenticRegistry(PAT, REPO, await deriveRegistryMacKey(NEW_PW, salt));
    const underOld = await readAuthenticRegistry(PAT, REPO, await deriveRegistryMacKey(OLD_PW, oldSalt));
    expect(underNew.map((e) => e.deviceId)).toEqual(['device-A']);
    expect(underOld).toEqual([]);
  });

  it('squashes the default branch so the old-key history is unreachable', async () => {
    await seed();
    expect(fakeRepo.historyLength()).toBeGreaterThan(1);
    await rotateSyncKey(NEW_PW);
    expect(fakeRepo.historyLength()).toBe(1);
    expect((await db.syncMeta.get('sync-meta'))?.lastMainSquashAt).toBeGreaterThan(0);
  });

  it('stores the new password, caches the new salt, syncs first, and forgets the pin', async () => {
    await seed();
    await rotateSyncKey(NEW_PW);
    const { salt } = await newKeyFromRemote();
    expect((await db.localSettings.get('local'))?.encryptionPassword).toBe(NEW_PW);
    expect(getCachedSalt()).toBe(salt);
    expect(await hasUnfinishedRotation()).toBe(false);
    expect(mockSyncNow).toHaveBeenCalledWith(true);
    expect(mockEndSyncSession.mock.invocationCallOrder[0]).toBeLessThan(mockSyncNow.mock.invocationCallOrder[0]);
  });

  it('keeps a shared file neither key opens, and counts it', async () => {
    await seed({ unreadableB2: true });
    const before = fakeRepo.readBytes(blobPath('b2'), BLOB_BRANCH)!;
    const result = await rotateSyncKey(NEW_PW);
    expect(result.blobsRewritten).toBe(2);
    expect(result.blobsUnreadable).toBe(1);
    expect(fakeRepo.readBytes(blobPath('b2'), BLOB_BRANCH)).toEqual(before);
  });
});

describe('rotateSyncKey refuses before touching anything', () => {
  it('when the pre-sync fails', async () => {
    await seed();
    const before = remoteState();
    mockSyncNow.mockResolvedValueOnce(-1);
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/Could not sync/);
    expect(remoteState()).toBe(before);
    expect((await db.localSettings.get('local'))?.encryptionPassword).toBe(OLD_PW);
    expect(await hasUnfinishedRotation()).toBe(false);
  });

  it('while changes are still waiting to be pushed', async () => {
    await seed();
    await db.changeLog.add(makeChangeEntry());
    const before = remoteState();
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/not synced yet/);
    expect(remoteState()).toBe(before);
  });

  it('when the shared files changed while they were being re-encrypted', async () => {
    await seed();
    const realCreateTree = fakeRepo.api.createTree;
    vi.spyOn(fakeRepo.api, 'createTree').mockImplementationOnce(async (pat, repo, entries) => {
      fakeRepo.writeBytes(blobPath('b9'), new Uint8Array([9]), BLOB_BRANCH); // another device uploads
      return realCreateTree(pat, repo, entries);
    });
    const snapshotBefore = fakeRepo.readText(SNAPSHOT_FILE);
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/changed while/);
    expect(fakeRepo.readText(SNAPSHOT_FILE)).toBe(snapshotBefore);
    expect(await decryptBytes(oldKey, fakeRepo.readBytes(blobPath('b1'), BLOB_BRANCH)!)).toEqual(PLAIN.b1);
    expect((await db.localSettings.get('local'))?.encryptionPassword).toBe(OLD_PW);
    expect(getCachedSalt()).toBe(oldSalt);
  });
});

describe('rotateSyncKey resumes', () => {
  it('after dying between the shared files and the snapshot: same password completes, another is refused', async () => {
    await seed();
    const realPutFile = fakeRepo.api.putFile;
    vi.spyOn(fakeRepo.api, 'putFile').mockImplementation(async (pat, repo, path, content, sha) => {
      if (path === SNAPSHOT_FILE) throw new Error('GitHub API error: 500');
      return realPutFile(pat, repo, path, content, sha);
    });
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/could not be rewritten/);
    vi.restoreAllMocks();
    mockSyncNow.mockResolvedValue(0);

    // Files rotated, snapshot not, this device still on the old key.
    const pinned = (await db.syncMeta.get('sync-meta'))!.keyRotation!;
    expect(pinned).toBeTruthy();
    const pinnedKey = await deriveKey(NEW_PW, pinned.newSalt);
    expect(await decryptBytes(pinnedKey, fakeRepo.readBytes(blobPath('b1'), BLOB_BRANCH)!)).toEqual(PLAIN.b1);
    expect((JSON.parse(fakeRepo.readText(SNAPSHOT_FILE)!) as SyncData).encryptionSalt).toBe(oldSalt);
    expect((await db.localSettings.get('local'))?.encryptionPassword).toBe(OLD_PW);
    expect(getCachedSalt()).toBe(oldSalt);

    await expect(rotateSyncKey(OTHER_PW)).rejects.toThrow(/did not finish/);
    expect((JSON.parse(fakeRepo.readText(SNAPSHOT_FILE)!) as SyncData).encryptionSalt).toBe(oldSalt);

    const createBlob = vi.spyOn(fakeRepo.api, 'createBlobBase64');
    const result = await rotateSyncKey(NEW_PW);
    expect(createBlob).not.toHaveBeenCalled(); // already rotated: nothing re-uploaded
    expect(result.blobsRewritten).toBe(0);
    const { salt } = await newKeyFromRemote();
    expect(salt).toBe(pinned.newSalt);
    expect((await db.localSettings.get('local'))?.encryptionPassword).toBe(NEW_PW);
    expect(await hasUnfinishedRotation()).toBe(false);
  });

  it('after dying past the snapshot: the retry finishes the backups, registry and history', async () => {
    await seed();
    const realPutFile = fakeRepo.api.putFile;
    vi.spyOn(fakeRepo.api, 'putFile').mockImplementation(async (pat, repo, path, content, sha) => {
      if (path === BACKUP_FILES.daily) throw new Error('GitHub API error: 500');
      return realPutFile(pat, repo, path, content, sha);
    });
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/500/);
    vi.restoreAllMocks();
    mockSyncNow.mockResolvedValue(0);

    expect((await db.localSettings.get('local'))?.encryptionPassword).toBe(NEW_PW);
    expect(await hasUnfinishedRotation()).toBe(true);
    const { key: newKey, salt } = await newKeyFromRemote();

    const createBlob = vi.spyOn(fakeRepo.api, 'createBlobBase64');
    const result = await rotateSyncKey(NEW_PW);
    expect(createBlob).not.toHaveBeenCalled();
    expect(result.historySquashed).toBe(true);
    const daily = JSON.parse(fakeRepo.readText(BACKUP_FILES.daily)!) as SyncData;
    expect(daily.encryptionSalt).toBe(salt);
    expect(await checkVerifier(newKey, daily.encryptionVerifier!)).toBe(true);
    expect((await readAuthenticRegistry(PAT, REPO, await deriveRegistryMacKey(NEW_PW, salt))).length).toBe(1);
    expect(fakeRepo.historyLength()).toBe(1);
    expect(await hasUnfinishedRotation()).toBe(false);
  });

  it('can discard an unfinished rotation', async () => {
    await seed();
    await db.syncMeta.update('sync-meta', { keyRotation: { newSalt: generateSalt(), newVerifier: 'x', startedAt: 1 } });
    expect(await hasUnfinishedRotation()).toBe(true);
    await discardUnfinishedRotation();
    expect(await hasUnfinishedRotation()).toBe(false);
  });
});
