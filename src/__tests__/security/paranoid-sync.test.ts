import { vi, type Mock } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });

vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  return { ...actual, getFile: vi.fn(), putFile: vi.fn(), deleteFile: vi.fn(), testConnection: vi.fn() };
});
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../sync/remote-backups', async () => {
  const actual = await vi.importActual('../../sync/remote-backups');
  return { ...actual, maybeCreateBackups: vi.fn(() => Promise.resolve()) };
});

import { db } from '../../db';
import { resetSyncState, setupSyncCredentials } from '../helpers/sync-helpers';
import { getFile, putFile } from '../../sync/github-api';
import { CHANGELOG_FILE, SNAPSHOT_FILE, syncNow } from '../../sync/sync-engine';
import {
  enableParanoid, disableParanoid, lock, getVaultSecrets, __resetVaultStateForTests,
} from '../../db/vault';
import { createVerifier, deriveKey, encryptSyncData, generateSalt } from '../../sync/crypto';
import { setMigrationBypass } from '../../db/vault-middleware';
import type { SyncData, Task } from '../../db/models';

const mockGetFile = getFile as Mock;
const mockPutFile = putFile as Mock;
const PASS = 'sync vault passphrase';

function seedTask() {
  const now = Date.now();
  return db.tasks.add({ id: 't1', listId: 'l1', title: 'x', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
}

async function rawTask(id: string): Promise<Record<string, unknown> | undefined> {
  setMigrationBypass(true);
  try {
    return (await db.tasks.get(id)) as unknown as Record<string, unknown> | undefined;
  } finally {
    setMigrationBypass(false);
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetSyncState();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  localStorage.removeItem('gtd25-paranoid-key');
  await setupSyncCredentials({ githubPat: 'ghp_vaultPAT', encryptionPassword: 'syncpw', deviceId: 'device-A' });
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  localStorage.removeItem('gtd25-paranoid-key');
});

describe('paranoid sync credential routing', () => {
  it('moves PAT + sync password into the vault and clears the plaintext copies on enable', async () => {
    await enableParanoid(PASS);

    const local = await db.localSettings.get('local');
    expect(local?.githubPat).toBeUndefined();
    expect(local?.encryptionPassword).toBeUndefined();
    expect(local?.githubRepo).toBe('user/repo'); // non-secret stays in localSettings
    expect(getVaultSecrets()).toEqual({ githubPat: 'ghp_vaultPAT', syncPassword: 'syncpw' });
  });

  it('restores the plaintext credentials on disable', async () => {
    await enableParanoid(PASS);
    await disableParanoid();

    const local = await db.localSettings.get('local');
    expect(local?.githubPat).toBe('ghp_vaultPAT');
    expect(local?.encryptionPassword).toBe('syncpw');
  });

  it('syncs using the vault PAT while unlocked', async () => {
    await enableParanoid(PASS);
    await seedTask();
    mockGetFile.mockResolvedValue(null); // fresh remote -> initial push
    mockPutFile.mockResolvedValue('sha');

    await syncNow(true);

    expect(mockPutFile).toHaveBeenCalled();
    expect(mockPutFile.mock.calls[0][0]).toBe('ghp_vaultPAT'); // PAT sourced from the vault
  });

  it('pre-encrypts pulled snapshot rows before writing them in Paranoid Mode', async () => {
    await enableParanoid(PASS);
    const salt = generateSalt();
    const syncKey = await deriveKey('syncpw', salt);
    const now = Date.now();
    const snapshot: SyncData = {
      syncVersion: 2,
      encryptionSalt: salt,
      encryptionVerifier: await createVerifier(syncKey),
      taskLists: [{ id: 'l-remote', name: 'Remote List', type: 'tasks', order: 1, createdAt: now, updatedAt: now }],
      tasks: [{ id: 't-remote', listId: 'l-remote', title: 'Remote Secret', status: 'todo', order: 1, createdAt: now, updatedAt: now }],
      subtasks: [],
      settings: { theme: 'system' },
    };
    const encryptedSnapshot = await encryptSyncData(syncKey, snapshot);
    const taskBulkPut = vi.spyOn(db.tasks, 'bulkPut');
    mockGetFile.mockImplementation((_pat: string, _repo: string, path: string) => {
      if (path === SNAPSHOT_FILE) return Promise.resolve({ data: JSON.stringify(encryptedSnapshot), sha: 'snapshot-sha' });
      if (path === CHANGELOG_FILE) return Promise.resolve(null);
      return Promise.resolve(null);
    });
    mockPutFile.mockResolvedValue('changelog-sha');

    try {
      const result = await syncNow(true);

      expect(result).toBe(0);
      const writtenRows = taskBulkPut.mock.calls.find((call) => {
        const rows = call[0] as unknown as ReadonlyArray<Record<string, unknown>>;
        return rows.some((row) => row.id === 't-remote');
      })?.[0] as unknown as ReadonlyArray<Record<string, unknown>>;
      expect(writtenRows[0]._enc).toEqual(expect.any(String));
      expect(writtenRows[0].title).toBeUndefined();
      expect((await db.tasks.get('t-remote'))?.title).toBe('Remote Secret');
      expect((await rawTask('t-remote'))?.title).toBeUndefined();
    } finally {
      taskBulkPut.mockRestore();
    }
  });

  it('does not sync while locked — no PAT is available', async () => {
    await enableParanoid(PASS);
    await seedTask();
    lock();
    mockGetFile.mockResolvedValue(null);
    mockPutFile.mockResolvedValue('sha');

    const result = await syncNow(true);

    expect(result).toBe(-1);                    // getCredentials returned null
    expect(mockPutFile).not.toHaveBeenCalled();
  });
});
