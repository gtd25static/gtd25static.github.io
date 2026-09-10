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
import { syncNow, endSyncSession, SNAPSHOT_FILE } from '../../sync/sync-engine';
import { cacheEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData } from '../../sync/crypto';

// Locking a Paranoid vault ends the sync session. A sync already past its network
// round-trip must not go on to write what it fetched: while locked those rows
// would reach the disk unencrypted, and after an unlock with the secondary
// passphrase they would put real remote content back into the placeholder vault.

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

/** A remote holding one real task, served only once `release()` is called. */
async function slowRemoteWithOneTask() {
  const now = Date.now();
  const data = makeSyncData({
    encryptionSalt: testSalt,
    encryptionVerifier: await createVerifier(testKey),
    taskLists: [{ id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: now, updatedAt: now } as TaskList],
    tasks: [{ id: 't1', listId: 'l1', title: 'REMOTE_TITLE', status: 'todo', order: 0, createdAt: now, updatedAt: now } as Task],
  }) as SyncData;
  const encrypted = JSON.stringify(await encryptSyncData(testKey, data));
  let release!: () => void;
  const served = new Promise<void>((resolve) => { release = resolve; });
  mockGetFile.mockImplementation(async (_pat: string, _repo: string, path: string) => {
    await served;
    return path === SNAPSHOT_FILE ? { data: encrypted, sha: 'snap-sha' } : null;
  });
  return { release };
}

describe('ending the sync session mid-sync', () => {
  it('a sync still waiting on the network writes nothing locally or remotely', async () => {
    const remote = await slowRemoteWithOneTask();

    const running = syncNow();
    await vi.waitFor(() => expect(mockGetFile).toHaveBeenCalled());
    endSyncSession();
    remote.release();

    await expect(running).resolves.toBe(-1);
    expect(await db.tasks.count()).toBe(0);
    expect(mockPutFile).not.toHaveBeenCalled();
  });

  it('control: the same sync, left alone, adopts the remote', async () => {
    const remote = await slowRemoteWithOneTask();

    const running = syncNow();
    remote.release();

    await expect(running).resolves.toBe(0);
    expect((await db.tasks.get('t1'))?.title).toBe('REMOTE_TITLE');
  });
});
