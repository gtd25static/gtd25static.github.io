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
import { rotateSyncKey, hasUnfinishedRotation, discardUnfinishedRotation, ROTATION_MARKER_FILE } from '../../sync/key-rotation';
import {
  deriveKey, generateSalt, createVerifier, checkVerifier, encryptBytes, decryptBytes,
  encryptSyncData, decryptSyncData, cacheEncryptionKey, getCachedSalt, encryptChangeEntries, decryptChangeEntries,
} from '../../sync/crypto';
import { syncNow, endSyncSession, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { BLOB_BRANCH, KEEP_PATH, blobPath, blobAad, decryptSharedBlob, paddedLength, sealSharedBlob } from '../../sync/shared-blobs';
import { BACKUP_FILES } from '../../sync/remote-backups';
import { publishOwnRegistryEntry, readAuthenticRegistry, buildRegistryEntry, REGISTRY_PATH, type RegistryTombstone } from '../../sync/remote-unlock';
import { deriveRegistryMacKey, registryMac, verifyRegistryMac } from '../../sync/remote-unlock-crypto';
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
      // Rewritten padded and bound to its id: it opens only as itself, and its
      // size no longer gives the file's away.
      expect(await decryptSharedBlob(newKey, bytes!, blobId)).toEqual(plain);
      await expect(decryptSharedBlob(newKey, bytes!, 'other-id')).rejects.toBeTruthy();
      expect(bytes!.length).toBe(paddedLength(plain.length) + 28);
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
    expect(JSON.parse(fakeRepo.readText(CHANGELOG_FILE)!)).toEqual([]);
  });

  it('drops the migration backups and writes none under the old key', async () => {
    await seed();
    await rotateSyncKey(NEW_PW);
    for (let v = 0; v <= SYNC_VERSION; v++) {
      expect(fakeRepo.sha(`gtd25-snapshot-v${v}.backup.json`), `v${v} backup`).toBeNull();
    }
  });

  it('re-encrypts each tier backup as it was — its own content and time, not today\'s snapshot', async () => {
    await seed();
    // The weekly restore point is older than the current data.
    const weekly = JSON.parse(fakeRepo.readText(BACKUP_FILES.weekly)!) as SyncData;
    const plainWeekly = await decryptSyncData(oldKey, weekly);
    plainWeekly.tasks = [{ ...plainWeekly.tasks[0], title: 'LAST_WEEK_TITLE' }];
    fakeRepo.writeText(BACKUP_FILES.weekly, JSON.stringify({ ...(await encryptSyncData(oldKey, plainWeekly)), backedUpAt: 7 }));

    await rotateSyncKey(NEW_PW);
    const { key: newKey, salt } = await newKeyFromRemote();
    for (const [tier, path] of Object.entries(BACKUP_FILES)) {
      const backup = JSON.parse(fakeRepo.readText(path)!) as SyncData & { backedUpAt: number };
      expect(backup.encryptionSalt, tier).toBe(salt);
      expect(await checkVerifier(newKey, backup.encryptionVerifier!), tier).toBe(true);
      expect(backup.backedUpAt, tier).toBe(tier === 'weekly' ? 7 : 1);
      const title = (await decryptSyncData(newKey, backup)).tasks[0].title;
      expect(title, tier).toBe(tier === 'weekly' ? 'LAST_WEEK_TITLE' : 'TASK_TITLE');
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

  it("gives each download the time its file's size needs, not the whole folder's", async () => {
    await seed();
    await rotateSyncKey(NEW_PW);
    expect(fakeRepo.downloadTimeouts.length).toBeGreaterThan(0);
    expect(new Set(fakeRepo.downloadTimeouts)).toEqual(new Set([15_000])); // small files
  });

  it('carries over — under the new key — a file whose item has not reached this device yet', async () => {
    // Another device's upload: on the branch, but its metadata not pulled here.
    // The rebuilt branch used to keep only files this device knew, so it was lost.
    await seed();
    fakeRepo.writeBytes(blobPath('b9'), await sealSharedBlob(oldKey, PLAIN.b1, 'b9'), BLOB_BRANCH);
    await rotateSyncKey(NEW_PW);
    const { key: newKey } = await newKeyFromRemote();
    expect(await decryptSharedBlob(newKey, fakeRepo.readBytes(blobPath('b9'), BLOB_BRANCH)!, 'b9')).toEqual(PLAIN.b1);
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

describe('rotateSyncKey stops before moving the shared files', () => {
  it('while a shared item cannot be read on this device', async () => {
    // Its file would look like one nobody uses, and be left behind.
    await seed();
    await db.sharedItems.update('si-b1', { _decryptError: true } as never);
    const blobBranchBefore = fakeRepo.refs.get(BLOB_BRANCH);
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/can.t be read/);
    expect(fakeRepo.refs.get(BLOB_BRANCH)).toBe(blobBranchBefore);
  });

  it('when a newer version of the app moved the repository on meanwhile', async () => {
    // Its devices would never get this key: the snapshot push that follows is
    // refused, and every file would be left under it.
    await seed();
    const snap = JSON.parse(fakeRepo.readText(SNAPSHOT_FILE)!) as SyncData;
    fakeRepo.writeText(SNAPSHOT_FILE, JSON.stringify({ ...snap, syncVersion: SYNC_VERSION + 1 }));
    const blobBranchBefore = fakeRepo.refs.get(BLOB_BRANCH);

    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/newer version/);
    expect(fakeRepo.refs.get(BLOB_BRANCH)).toBe(blobBranchBefore);
    expect(await decryptBytes(oldKey, fakeRepo.readBytes(blobPath('b1'), BLOB_BRANCH)!)).toEqual(PLAIN.b1);
  });
});

// Reliability review 2026-10-06 (M10): a change that failed before its commit
// point said "Nothing was changed" but left its remote mark (and the pin) behind:
// every device then refused Shared Folder uploads and skipped its backups until
// this one finished or forgot it — and a retry hit the same failure.
describe('rotateSyncKey stopped before the files moved leaves nothing behind', () => {
  it('no remote mark and no pin after a "nothing was changed" failure', async () => {
    await seed();
    await db.sharedItems.update('si-b1', { _decryptError: true } as never);

    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/Nothing was changed/);

    expect(fakeRepo.readText(ROTATION_MARKER_FILE)).toBeNull();
    expect(await hasUnfinishedRotation()).toBe(false);
  });

  it('a network failure before the branch moved is undone the same way', async () => {
    await seed();
    const original = fakeRepo.api.createTree;
    fakeRepo.api.createTree = vi.fn(async () => { throw new Error('Failed to fetch'); });
    try {
      await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/Failed to fetch/);
    } finally {
      fakeRepo.api.createTree = original;
    }

    expect(fakeRepo.readText(ROTATION_MARKER_FILE)).toBeNull();
    expect(await hasUnfinishedRotation()).toBe(false);
  });

  it('keeps the mark and pin when the branch did move (the change must be finished)', async () => {
    await seed();
    const original = fakeRepo.api.updateRef;
    fakeRepo.api.updateRef = vi.fn(async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw new Error('Failed to fetch'); // the reply was lost after the ref moved
    }) as typeof original;
    try {
      await expect(rotateSyncKey(NEW_PW)).rejects.toThrow();
    } finally {
      fakeRepo.api.updateRef = original;
    }

    expect(fakeRepo.readText(ROTATION_MARKER_FILE)).not.toBeNull();
    expect(await hasUnfinishedRotation()).toBe(true);
  });

  it('an unfinished change resumed here keeps its pin and mark whatever fails', async () => {
    await seed();
    // Pinned by an earlier attempt (its files may have moved since).
    const newSalt = generateSalt();
    const pin = { newSalt, newVerifier: await createVerifier(await deriveKey(NEW_PW, newSalt)), startedAt: 1 };
    await db.syncMeta.update('sync-meta', { keyRotation: pin });
    fakeRepo.writeText(ROTATION_MARKER_FILE, JSON.stringify(pin));
    const original = fakeRepo.api.createTree;
    fakeRepo.api.createTree = vi.fn(async () => { throw new Error('Failed to fetch'); });
    try {
      await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/Failed to fetch/);
    } finally {
      fakeRepo.api.createTree = original;
    }
    expect(await hasUnfinishedRotation()).toBe(true);
    expect(fakeRepo.readText(ROTATION_MARKER_FILE)).not.toBeNull();
  });
});

describe('rotateSyncKey resumes', () => {
  it('padding a file already under the new key but written without padding', async () => {
    await seed();
    const newSalt = generateSalt();
    const newKey = await deriveKey(NEW_PW, newSalt);
    await db.syncMeta.update('sync-meta', { keyRotation: { newSalt, newVerifier: await createVerifier(newKey), startedAt: 1 } });
    fakeRepo.writeBytes(blobPath('b1'), await encryptBytes(newKey, PLAIN.b1, blobAad('b1')), BLOB_BRANCH);

    await rotateSyncKey(NEW_PW);
    const bytes = fakeRepo.readBytes(blobPath('b1'), BLOB_BRANCH)!;
    expect(bytes.length).toBe(paddedLength(PLAIN.b1.length) + 28);
    expect(await decryptSharedBlob(newKey, bytes, 'b1')).toEqual(PLAIN.b1);
  });

  it('after dying between the shared files and the snapshot: same password completes, another is refused', async () => {
    await seed();
    const realPutFile = fakeRepo.api.putFile;
    vi.spyOn(fakeRepo.api, 'putFile').mockImplementation(async (pat, repo, path, content, sha) => {
      if (path === SNAPSHOT_FILE) throw new Error('GitHub API error: 500');
      return realPutFile(pat, repo, path, content, sha);
    });
    const failure = rotateSyncKey(NEW_PW);
    await expect(failure).rejects.toThrow(/already re-encrypted/);
    await expect(failure).rejects.not.toThrow(/Nothing was changed/);
    vi.restoreAllMocks();
    mockSyncNow.mockResolvedValue(0);

    // Files rotated, snapshot not, this device still on the old key.
    const pinned = (await db.syncMeta.get('sync-meta'))!.keyRotation!;
    expect(pinned).toBeTruthy();
    const pinnedKey = await deriveKey(NEW_PW, pinned.newSalt);
    expect(await decryptSharedBlob(pinnedKey, fakeRepo.readBytes(blobPath('b1'), BLOB_BRANCH)!, 'b1')).toEqual(PLAIN.b1);
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

describe('rotateSyncKey across devices and failures (reliability review)', () => {
  it('marks the rotation on the remote before the files move, and clears the mark at the end', async () => {
    await seed();
    const realUpdateRef = fakeRepo.api.updateRef;
    let markedWhenFilesMoved = false;
    vi.spyOn(fakeRepo.api, 'updateRef').mockImplementation(async (pat, repo, branch, sha, force) => {
      if (branch === BLOB_BRANCH) markedWhenFilesMoved = fakeRepo.sha(ROTATION_MARKER_FILE) !== null;
      return realUpdateRef(pat, repo, branch, sha, force);
    });
    await rotateSyncKey(NEW_PW);
    expect(markedWhenFilesMoved).toBe(true);
    expect(fakeRepo.sha(ROTATION_MARKER_FILE)).toBeNull();
  });

  it('a second device finishes the change from the remote mark with the same password, and refuses another', async () => {
    await seed();
    const realPutFile = fakeRepo.api.putFile;
    vi.spyOn(fakeRepo.api, 'putFile').mockImplementation(async (pat, repo, path, content, sha) => {
      if (path === SNAPSHOT_FILE) throw new Error('GitHub API error: 500');
      return realPutFile(pat, repo, path, content, sha);
    });
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/already re-encrypted/);
    vi.restoreAllMocks();
    mockSyncNow.mockResolvedValue(0);

    // The same repo seen from a device that never held the local pin.
    await db.syncMeta.update('sync-meta', { keyRotation: undefined });
    cacheEncryptionKey(oldKey, oldSalt);
    await expect(rotateSyncKey(OTHER_PW)).rejects.toThrow(/another device|did not finish/);
    expect((JSON.parse(fakeRepo.readText(SNAPSHOT_FILE)!) as SyncData).encryptionSalt).toBe(oldSalt);

    const result = await rotateSyncKey(NEW_PW);
    expect(result.blobsUnreadable).toBe(0);
    const { key: newKey } = await newKeyFromRemote();
    expect(await decryptSharedBlob(newKey, fakeRepo.readBytes(blobPath('b1'), BLOB_BRANCH)!, 'b1')).toEqual(PLAIN.b1);
    expect(fakeRepo.sha(ROTATION_MARKER_FILE)).toBeNull();
  });

  it('forgetting an unfinished change also clears its remote mark — and only its own', async () => {
    await seed();
    const pin = { newSalt: generateSalt(), newVerifier: 'x', startedAt: 1 };
    await db.syncMeta.update('sync-meta', { keyRotation: pin });
    fakeRepo.writeText(ROTATION_MARKER_FILE, JSON.stringify({ newSalt: 'another-change', newVerifier: 'y', startedAt: 2 }));
    await discardUnfinishedRotation();
    expect(fakeRepo.sha(ROTATION_MARKER_FILE)).not.toBeNull(); // another change's mark stays

    await db.syncMeta.update('sync-meta', { keyRotation: pin });
    fakeRepo.writeText(ROTATION_MARKER_FILE, JSON.stringify(pin));
    await discardUnfinishedRotation();
    expect(fakeRepo.sha(ROTATION_MARKER_FILE)).toBeNull();
  });

  it('finishes when the snapshot landed but the step after it failed (the push "failed" after the commit point)', async () => {
    await seed();
    const realPutFile = fakeRepo.api.putFile;
    let failed = false;
    vi.spyOn(fakeRepo.api, 'putFile').mockImplementation(async (pat, repo, path, content, sha) => {
      if (path === CHANGELOG_FILE && !failed) { failed = true; throw new Error('GitHub API error: 502'); }
      return realPutFile(pat, repo, path, content, sha);
    });
    await rotateSyncKey(NEW_PW);
    const { salt } = await newKeyFromRemote();
    expect(salt).not.toBe(oldSalt);
    expect(getCachedSalt()).toBe(salt); // this device on the key the remote now has
    expect((await db.localSettings.get('local'))?.encryptionPassword).toBe(NEW_PW);
    expect(await hasUnfinishedRotation()).toBe(false);
  });

  it('keeps — under the new key — changes another device pushed while the files were moving', async () => {
    await seed();
    const realCreateTree = fakeRepo.api.createTree;
    const pushed = makeChangeEntry({ deviceId: 'device-B', entityType: 'task', entityId: 't1' });
    pushed.data = { ...pushed.data!, id: 't1', title: 'EDITED_ON_B' };
    vi.spyOn(fakeRepo.api, 'createTree').mockImplementationOnce(async (pat, repo, entries) => {
      const sha = fakeRepo.sha(CHANGELOG_FILE)!;
      fakeRepo.writeText(CHANGELOG_FILE, JSON.stringify(await encryptChangeEntries(oldKey, [pushed])), 'main', sha);
      return realCreateTree(pat, repo, entries);
    });
    await rotateSyncKey(NEW_PW);
    const { key: newKey } = await newKeyFromRemote();
    const entries = await decryptChangeEntries(newKey, JSON.parse(fakeRepo.readText(CHANGELOG_FILE)!));
    expect(entries.map((e) => e.id)).toContain(pushed.id);
    expect(entries.find((e) => e.id === pushed.id)!.data!.title).toBe('EDITED_ON_B');
  });

  it("re-MACs the other devices' entries and the tombstones under the new key", async () => {
    await seed();
    const oldMac = await deriveRegistryMacKey(OLD_PW, oldSalt);
    const reg = JSON.parse(fakeRepo.readText(REGISTRY_PATH)!) as Record<string, unknown>;
    const ids = { ecdhPub: { kty: 'EC' }, ecdsaPub: { kty: 'EC' } } as never;
    reg['device-B'] = await buildRegistryEntry('device-B', 'Phone', ids, false, oldMac);
    const removedAt = 1234;
    reg['device-C'] = { deviceId: 'device-C', removed: true, removedAt, mac: await registryMac(oldMac, new TextEncoder().encode(`registry-tombstone|device-C|${removedAt}`)) };
    fakeRepo.writeText(REGISTRY_PATH, JSON.stringify(reg), 'main', fakeRepo.sha(REGISTRY_PATH)!);

    await rotateSyncKey(NEW_PW);
    const { salt } = await newKeyFromRemote();
    const newMac = await deriveRegistryMacKey(NEW_PW, salt);
    const authentic = await readAuthenticRegistry(PAT, REPO, newMac);
    expect(authentic.map((e) => e.deviceId).sort()).toEqual(['device-A', 'device-B']);
    const tomb = (JSON.parse(fakeRepo.readText(REGISTRY_PATH)!) as Record<string, RegistryTombstone>)['device-C'];
    expect(await verifyRegistryMac(newMac, tomb.mac, new TextEncoder().encode(`registry-tombstone|device-C|${removedAt}`))).toBe(true);
  });

  it('keeps the pin when an old-key leftover could not be deleted, so a retry finishes it', async () => {
    await seed();
    const realDelete = fakeRepo.api.deleteFile;
    vi.spyOn(fakeRepo.api, 'deleteFile').mockImplementation(async (pat, repo, path, sha, signal, branch) => {
      if (path === MIGRATION_BACKUP) throw new Error('GitHub API error deleting: 502');
      return realDelete(pat, repo, path, sha, signal, branch);
    });
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/could not be deleted/);
    expect(await hasUnfinishedRotation()).toBe(true);
    vi.restoreAllMocks();
    mockSyncNow.mockResolvedValue(0);
    await rotateSyncKey(NEW_PW);
    expect(fakeRepo.sha(MIGRATION_BACKUP)).toBeNull();
    expect(await hasUnfinishedRotation()).toBe(false);
  });
});

describe('rotateSyncKey — final review', () => {
  it('a retry after the commit point still has the old key: tier backups keep their content, every entry and tombstone is re-MACed', async () => {
    await seed();
    const oldMac = await deriveRegistryMacKey(OLD_PW, oldSalt);
    const reg = JSON.parse(fakeRepo.readText(REGISTRY_PATH)!) as Record<string, unknown>;
    reg['device-B'] = await buildRegistryEntry('device-B', 'Phone', { ecdhPub: { kty: 'EC' }, ecdsaPub: { kty: 'EC' } } as never, false, oldMac);
    fakeRepo.writeText(REGISTRY_PATH, JSON.stringify(reg), 'main', fakeRepo.sha(REGISTRY_PATH)!);
    const realPutFile = fakeRepo.api.putFile;
    vi.spyOn(fakeRepo.api, 'putFile').mockImplementation(async (pat, repo, path, content, sha) => {
      if (path === BACKUP_FILES.hourly) throw new Error('GitHub API error: 502'); // step 5, after the commit
      return realPutFile(pat, repo, path, content, sha);
    });
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow();
    vi.restoreAllMocks();
    mockSyncNow.mockResolvedValue(0);

    await rotateSyncKey(NEW_PW); // the resume: this device now holds only the new key
    const { key: newKey, salt } = await newKeyFromRemote();
    for (const path of Object.values(BACKUP_FILES)) {
      const backup = JSON.parse(fakeRepo.readText(path)!) as SyncData & { backedUpAt: number };
      expect(backup.backedUpAt, path).toBe(1); // its own restore point, not today's snapshot
      expect((await decryptSyncData(newKey, backup)).tasks[0].title).toBe('TASK_TITLE');
    }
    const authentic = await readAuthenticRegistry(PAT, REPO, await deriveRegistryMacKey(NEW_PW, salt));
    expect(authentic.map((e) => e.deviceId).sort()).toEqual(['device-A', 'device-B']);
    expect((await db.localSettings.get('local'))?.previousEncryptionPassword).toBeUndefined(); // forgotten once done
  });

  it('what another device compacted into the snapshot while the files moved is kept, not overwritten', async () => {
    await seed();
    const realCreateTree = fakeRepo.api.createTree;
    vi.spyOn(fakeRepo.api, 'createTree').mockImplementationOnce(async (pat, repo, entries) => {
      const snap = await decryptSyncData(oldKey, JSON.parse(fakeRepo.readText(SNAPSHOT_FILE)!));
      snap.tasks.push({ id: 't-b', listId: 'l1', title: 'COMPACTED_ON_B', status: 'todo', order: 1, createdAt: 2, updatedAt: 2, fieldTimestamps: { title: 2 } } as Task);
      fakeRepo.writeText(SNAPSHOT_FILE, JSON.stringify(await encryptSyncData(oldKey, snap)), 'main', fakeRepo.sha(SNAPSHOT_FILE)!);
      return realCreateTree(pat, repo, entries);
    });
    await rotateSyncKey(NEW_PW);
    const { key: newKey } = await newKeyFromRemote();
    const titles = (await decryptSyncData(newKey, JSON.parse(fakeRepo.readText(SNAPSHOT_FILE)!))).tasks.map((t) => t.title);
    expect(titles).toContain('COMPACTED_ON_B');
  });

  it('a reset made elsewhere while the files moved stops the change before its commit point', async () => {
    await seed();
    const realCreateTree = fakeRepo.api.createTree;
    vi.spyOn(fakeRepo.api, 'createTree').mockImplementationOnce(async (pat, repo, entries) => {
      const snap = await decryptSyncData(oldKey, JSON.parse(fakeRepo.readText(SNAPSHOT_FILE)!));
      fakeRepo.writeText(SNAPSHOT_FILE, JSON.stringify(await encryptSyncData(oldKey, { ...snap, tasks: [], wipedAt: Date.now() })), 'main', fakeRepo.sha(SNAPSHOT_FILE)!);
      return realCreateTree(pat, repo, entries);
    });
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow();
    expect((JSON.parse(fakeRepo.readText(SNAPSHOT_FILE)!) as SyncData).encryptionSalt).toBe(oldSalt);
  });

  it('a leftover mark of a change that did commit does not block the next one', async () => {
    await seed();
    // The remote is on oldSalt; a mark naming oldSalt is a finished change's leftover.
    fakeRepo.writeText(ROTATION_MARKER_FILE, JSON.stringify({ newSalt: oldSalt, newVerifier: await createVerifier(oldKey), startedAt: 1 }));
    await rotateSyncKey(NEW_PW);
    const { salt } = await newKeyFromRemote();
    expect(salt).not.toBe(oldSalt);
    expect(fakeRepo.sha(ROTATION_MARKER_FILE)).toBeNull();
  });

  it('another device\'s unfinished change shows here (banner + Forget) when a different password is tried', async () => {
    await seed();
    const otherSalt = generateSalt();
    fakeRepo.writeText(ROTATION_MARKER_FILE, JSON.stringify({ newSalt: otherSalt, newVerifier: await createVerifier(await deriveKey(OTHER_PW, otherSalt)), startedAt: 1 }));
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/another device/);
    expect(await hasUnfinishedRotation()).toBe(true);
    // Forget removes that mark (it is the one the local pin names).
    await discardUnfinishedRotation();
    expect(fakeRepo.sha(ROTATION_MARKER_FILE)).toBeNull();
    expect(await hasUnfinishedRotation()).toBe(false);
  });

  it('forgetting keeps the pin when the remote mark cannot be removed', async () => {
    await seed();
    const pin = { newSalt: generateSalt(), newVerifier: 'v', startedAt: 1 };
    await db.syncMeta.update('sync-meta', { keyRotation: pin });
    fakeRepo.writeText(ROTATION_MARKER_FILE, JSON.stringify(pin));
    vi.spyOn(fakeRepo.api, 'deleteFile').mockRejectedValueOnce(new Error('GitHub API error deleting: 502'));
    await expect(discardUnfinishedRotation()).rejects.toThrow();
    expect(await hasUnfinishedRotation()).toBe(true);
  });

  it('two devices starting at once: the second gets a plain message and no stale pin', async () => {
    await seed();
    const realPutFile = fakeRepo.api.putFile;
    vi.spyOn(fakeRepo.api, 'putFile').mockImplementation(async (pat, repo, path, content, sha) => {
      if (path === ROTATION_MARKER_FILE && !sha) {
        const s2 = generateSalt();
        fakeRepo.writeText(ROTATION_MARKER_FILE, JSON.stringify({ newSalt: s2, newVerifier: await createVerifier(await deriveKey(OTHER_PW, s2)), startedAt: 2 }));
        throw new Error('CONFLICT');
      }
      return realPutFile(pat, repo, path, content, sha);
    });
    await expect(rotateSyncKey(NEW_PW)).rejects.toThrow(/another device/);
    expect(await hasUnfinishedRotation()).toBe(false);
  });

  it('the re-keyed changelog never keeps the bytes it had (a stale PUT with the old sha must fail)', async () => {
    await seed();
    const before = fakeRepo.sha(CHANGELOG_FILE);
    const beforeText = fakeRepo.readText(CHANGELOG_FILE);
    await rotateSyncKey(NEW_PW);
    expect(beforeText).toBe('[]');
    expect(fakeRepo.readText(CHANGELOG_FILE)).not.toBe('[]');
    expect(fakeRepo.sha(CHANGELOG_FILE)).not.toBe(before);
  });
});
