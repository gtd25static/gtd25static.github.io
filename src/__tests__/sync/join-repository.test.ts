// joinRepository (the end of a QR enrolment): adopt the delivered credentials
// and replace this device's data with the repository's — all or nothing, and
// never by uploading this device's data there.
vi.setConfig({ testTimeout: 60_000 }); // real PBKDF2 (600k)

vi.mock('../../sync/github-api', async () => (await import('../helpers/fake-repo')).fakeGitHubApi);
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

import { db } from '../../db';
import type { SyncData, TaskList } from '../../db/models';
import { resetSyncState, setupSyncCredentials, makeChangeEntry } from '../helpers/sync-helpers';
import { fakeRepo, fakeGitHubApi } from '../helpers/fake-repo';
import { deriveKey, generateSalt, createVerifier, encryptSyncData } from '../../sync/crypto';
import { joinRepository, syncNow, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { getPendingIds } from '../../sync/change-log';
import { PARANOID_FLAG } from '../../db/paranoid-flag';
import { SYNC_VERSION } from '../../sync/version';

const PASSWORD = 'ring password from the old device';
const CREDS = { pat: 'github_pat_newdevicetoken0123456789', repo: 'owner/ring-repo', password: PASSWORD };

async function seedRemote(overrides: Partial<SyncData> = {}): Promise<void> {
  const salt = generateSalt();
  const key = await deriveKey(PASSWORD, salt);
  const remoteList = { id: 'remote-list', name: 'FROM THE RING', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList;
  const plain: SyncData = {
    syncVersion: SYNC_VERSION, encryptionSalt: salt, encryptionVerifier: await createVerifier(key),
    taskLists: [remoteList], tasks: [], subtasks: [], sharedItems: [],
    mindmapFolders: [], mindmaps: [], mindmapNodes: [], settings: { theme: 'system' },
    ...overrides,
  };
  fakeRepo.writeText(SNAPSHOT_FILE, JSON.stringify(await encryptSyncData(key, plain)));
  fakeRepo.writeText(CHANGELOG_FILE, '[]');
}

/** A device that synced another repository before, mid password change, with an unsynced change. */
async function seedDeviceSyncingElsewhere(): Promise<void> {
  await setupSyncCredentials({ githubRepo: 'owner/other-repo', encryptionPassword: 'old password of another ring' });
  await db.syncMeta.put({
    id: 'sync-meta', pendingChanges: true, lastPulledAt: 1_000, encryptedRepo: 'owner/other-repo', blobPurgeAll: true,
    keyRotation: { newSalt: 's', newVerifier: 'v', startedAt: 1 }, conflictBaseSince: 42,
  });
  await db.taskLists.add({ id: 'local-list', name: 'LOCAL ONLY', type: 'tasks', order: 0, createdAt: 2, updatedAt: 2 } as TaskList);
  await db.changeLog.add(makeChangeEntry({ entityType: 'taskList', entityId: 'local-list' }));
}

async function localState() {
  return {
    settings: await db.localSettings.get('local'),
    meta: await db.syncMeta.get('sync-meta'),
    lists: (await db.taskLists.toArray()).map((l) => l.id),
    pending: await getPendingIds(),
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  fakeRepo.reset();
  await resetSyncState();
  localStorage.removeItem(PARANOID_FLAG);
});

describe('joinRepository', () => {
  it('replaces the local data and the old sync state, and uploads none of it', async () => {
    await seedRemote();
    await seedDeviceSyncingElsewhere();
    const changelogBefore = fakeRepo.readText(CHANGELOG_FILE);
    const snapshotBefore = fakeRepo.readText(SNAPSHOT_FILE);

    expect(await joinRepository(CREDS)).toEqual({ joined: true });

    expect((await db.taskLists.toArray()).map((l) => [l.id, l.name])).toEqual([['remote-list', 'FROM THE RING']]);
    expect(await getPendingIds()).toEqual([]);
    expect(fakeRepo.readText(CHANGELOG_FILE)).toBe(changelogBefore);
    expect(fakeRepo.readText(SNAPSHOT_FILE)).toBe(snapshotBefore);
    expect(await db.localSettings.get('local')).toMatchObject({
      githubPat: CREDS.pat, githubRepo: CREDS.repo, encryptionPassword: PASSWORD, syncEnabled: true,
    });
    // Nothing of the other repository's sync state carries over (an unfinished
    // password change would run against this one; a pending purge would drop files).
    const meta = await db.syncMeta.get('sync-meta');
    expect(meta?.keyRotation).toBeUndefined();
    expect(meta?.blobPurgeAll).toBeUndefined();
    expect(meta?.encryptedRepo).toBe(CREDS.repo);
    expect(meta?.conflictBaseSince).toBe(42);
    expect(await db.localBackups.count()).toBeGreaterThan(0); // a safety copy of what was replaced
  });

  it('refuses a repository without data, changes nothing, and no later sync uploads this device\'s data', async () => {
    // A device with data of its own that does not sync, shown a QR for a
    // repository with no snapshot (e.g. by someone else's device).
    fakeRepo.writeText('README.md', 'an empty ring');
    await db.taskLists.add({ id: 'local-list', name: 'LOCAL ONLY', type: 'tasks', order: 0, createdAt: 2, updatedAt: 2 } as TaskList);
    const before = await localState();

    const result = await joinRepository(CREDS);
    expect(result.joined).toBe(false);
    expect(await localState()).toEqual(before);

    await syncNow(true);
    expect(fakeRepo.sha(SNAPSHOT_FILE)).toBeNull();
  });

  it('refuses a password that does not open the repository, and changes nothing', async () => {
    await seedRemote();
    await seedDeviceSyncingElsewhere();
    const before = await localState();

    const result = await joinRepository({ ...CREDS, password: 'not the ring password' });
    expect(result).toMatchObject({ joined: false, reason: expect.stringMatching(/does not open/) });
    expect(await localState()).toEqual(before);
  });

  it('refuses a repository written by a newer version', async () => {
    await seedRemote({ syncVersion: SYNC_VERSION + 1 });
    const result = await joinRepository(CREDS);
    expect(result).toMatchObject({ joined: false, reason: expect.stringMatching(/newer version/) });
    expect((await db.localSettings.get('local'))?.githubRepo).toBeUndefined();
  });

  it('puts everything back when the pull fails after the checks', async () => {
    await seedRemote();
    await seedDeviceSyncingElsewhere();
    const before = await localState();
    const realGetFile = fakeGitHubApi.getFile;
    vi.spyOn(fakeGitHubApi, 'getFile').mockImplementation(async (...args: Parameters<typeof realGetFile>) => {
      if (args[2] === CHANGELOG_FILE) throw new Error('GitHub API error: 502');
      return realGetFile(...args);
    });

    const result = await joinRepository(CREDS);
    expect(result).toMatchObject({ joined: false, reason: expect.stringMatching(/Nothing was changed/) });
    expect(await localState()).toEqual(before);
  });

  it('is refused in Paranoid Mode', async () => {
    localStorage.setItem(PARANOID_FLAG, '1');
    await expect(joinRepository(CREDS)).rejects.toThrow(/Paranoid/);
    expect((await db.localSettings.get('local'))?.githubRepo).not.toBe(CREDS.repo);
  });
});
