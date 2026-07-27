import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData } from '../helpers/sync-helpers';
import type { SyncData, Task, TaskList } from '../../db/models';

vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  return { ...actual, getFile: vi.fn(), putFile: vi.fn(), deleteFile: vi.fn(), testConnection: vi.fn() };
});
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../sync/remote-backups', async () => ({
  ...(await vi.importActual('../../sync/remote-backups')),
  maybeCreateBackups: vi.fn(() => Promise.resolve()),
}));

import { getFile, putFile } from '../../sync/github-api';
import { syncNow, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { cacheEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData } from '../../sync/crypto';

const mockGetFile = getFile as Mock;
const mockPutFile = putFile as Mock;

let testKey: CryptoKey;
let testSalt: string;

beforeAll(async () => {
  testSalt = generateSalt();
  testKey = await deriveKey('test-password', testSalt);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetSyncState();
  await setupSyncCredentials();
  cacheEncryptionKey(testKey, testSalt);
});

/** A remote that has a snapshot but NO changelog — the state that used to be
 *  read as "this device is new, adopt the remote". */
async function remoteWithSnapshotOnly(snapshotOverrides?: Partial<SyncData>) {
  const data = makeSyncData({
    encryptionSalt: testSalt,
    encryptionVerifier: await createVerifier(testKey),
    ...snapshotOverrides,
  }) as SyncData;
  const encrypted = JSON.stringify(await encryptSyncData(testKey, data));
  mockGetFile.mockImplementation(async (_pat: string, _repo: string, path: string) =>
    path === SNAPSHOT_FILE ? { data: encrypted, sha: 'snap-sha' } : null,
  );
}

async function seedLocalWork() {
  const now = Date.now();
  await db.taskLists.add({ id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: now, updatedAt: now } as TaskList);
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'Unpushed work', status: 'todo', order: 0, createdAt: now, updatedAt: now } as Task);
}

describe('remote snapshot with no changelog', () => {
  it('refuses to replace local data, and changes nothing on either side', async () => {
    // The branch clears the local tables AND the pending changelog, so taking it
    // with local data present destroyed unpushed work with a success toast.
    await seedLocalWork();
    await remoteWithSnapshotOnly();

    const result = await syncNow();

    expect(result).toBe(-1);
    expect(await db.tasks.count()).toBe(1);
    expect((await db.tasks.get('t1'))?.title).toBe('Unpushed work');
    expect(await db.taskLists.count()).toBe(1);
    expect(mockPutFile).not.toHaveBeenCalled(); // and the remote is left alone
  });

  it('keeps the pending changelog so the work can still be pushed', async () => {
    await seedLocalWork();
    await db.changeLog.add({
      id: 'c1', deviceId: 'device-A', timestamp: Date.now(),
      entityType: 'task', entityId: 't1', operation: 'upsert', v: 6,
      data: { id: 't1', title: 'Unpushed work' },
    });
    await remoteWithSnapshotOnly();

    await syncNow();

    expect(await db.changeLog.count()).toBe(1);
  });

  it('still adopts the remote when there is genuinely nothing here', async () => {
    // The case the branch was written for: a new device pointed at an existing repo.
    const now = Date.now();
    await remoteWithSnapshotOnly({
      taskLists: [{ id: 'r1', name: 'Remote list', type: 'tasks', order: 0, createdAt: now, updatedAt: now } as TaskList],
      tasks: [{ id: 'rt1', listId: 'r1', title: 'From remote', status: 'todo', order: 0, createdAt: now, updatedAt: now } as Task],
    });
    mockPutFile.mockResolvedValue('sha');

    const result = await syncNow();

    expect(result).toBe(0);
    expect((await db.tasks.get('rt1'))?.title).toBe('From remote');
    expect(mockPutFile).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), CHANGELOG_FILE, '[]', undefined, expect.anything(),
    );
  });
});
