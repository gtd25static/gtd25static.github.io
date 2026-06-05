import { vi, type Mock } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });

vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  return { ...actual, getFile: vi.fn(), putFile: vi.fn(), deleteFile: vi.fn(), testConnection: vi.fn() };
});
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

import { db } from '../../db';
import { resetSyncState, setupSyncCredentials } from '../helpers/sync-helpers';
import { getFile, putFile } from '../../sync/github-api';
import { toast } from '../../components/ui/Toast';
import { forcePush, wipeAllData, SNAPSHOT_FILE } from '../../sync/sync-engine';
import { deriveKey, generateSalt, cacheEncryptionKey } from '../../sync/crypto';
import { SYNC_VERSION } from '../../sync/version';
import type { SyncData, Task } from '../../db/models';

const mockGetFile = getFile as Mock;
const mockPutFile = putFile as Mock;
const mockToast = toast as Mock;

function remoteSnapshot(taskCount: number): string {
  const data: SyncData = {
    syncVersion: SYNC_VERSION,
    taskLists: [],
    tasks: Array.from({ length: taskCount }, (_, i) => ({ id: `r${i}` } as Task)),
    subtasks: [],
    settings: { theme: 'system' },
  };
  return JSON.stringify(data);
}

let testKey: CryptoKey;
let testSalt: string;

beforeEach(async () => {
  vi.clearAllMocks();
  await resetSyncState();
  await setupSyncCredentials();
  testSalt = generateSalt();
  testKey = await deriveKey('pw', testSalt);
  cacheEncryptionKey(testKey, testSalt);
});

describe('sync data-loss guards', () => {
  it('forcePush refuses to overwrite a populated remote with an empty local DB', async () => {
    // Local is empty (resetSyncState clears the DB); remote has data.
    mockGetFile.mockImplementation((_p: string, _r: string, path: string) =>
      Promise.resolve(path === SNAPSHOT_FILE ? { data: remoteSnapshot(3), sha: 'sha' } : null));
    mockPutFile.mockResolvedValue('sha');

    await forcePush();

    // The snapshot must NOT be overwritten (a backup PUT to a different file is ok).
    const snapshotWrites = mockPutFile.mock.calls.filter((c: string[]) => c[2] === SNAPSHOT_FILE);
    expect(snapshotWrites).toHaveLength(0);
    expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/refused/i), 'error');
  });

  it('forcePush proceeds when local has data', async () => {
    const now = Date.now();
    await db.tasks.add({ id: 't1', listId: 'l1', title: 'x', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
    mockGetFile.mockImplementation((_p: string, _r: string, path: string) =>
      Promise.resolve(path === SNAPSHOT_FILE ? { data: remoteSnapshot(3), sha: 'sha' } : null));
    mockPutFile.mockResolvedValue('sha');

    await forcePush();

    expect(mockPutFile.mock.calls.some((c: string[]) => c[2] === SNAPSHOT_FILE)).toBe(true);
  });

  it('wipeAllData backs up the remote snapshot before pushing the empty one', async () => {
    const now = Date.now();
    await db.tasks.add({ id: 't1', listId: 'l1', title: 'x', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
    mockGetFile.mockImplementation((_p: string, _r: string, path: string) =>
      Promise.resolve(path === SNAPSHOT_FILE ? { data: remoteSnapshot(3), sha: 'sha' } : null));
    mockPutFile.mockResolvedValue('sha');

    await wipeAllData();

    const paths = mockPutFile.mock.calls.map((c: string[]) => c[2]);
    const backupIdx = paths.findIndex((p) => /backup\.json$/.test(p));
    const snapshotIdx = paths.indexOf(SNAPSHOT_FILE);
    expect(backupIdx).toBeGreaterThanOrEqual(0);   // a recovery backup was written
    expect(snapshotIdx).toBeGreaterThanOrEqual(0); // the empty snapshot was pushed
    expect(backupIdx).toBeLessThan(snapshotIdx);   // backup happened FIRST

    // The pushed snapshot is the empty/wiped one.
    const pushed = JSON.parse(mockPutFile.mock.calls[snapshotIdx][3]) as SyncData & { wipedAt?: number };
    expect(pushed.tasks).toHaveLength(0);
    expect(pushed.wipedAt).toBeTruthy();
  });
});
