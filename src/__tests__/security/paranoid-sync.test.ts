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
import { syncNow } from '../../sync/sync-engine';
import {
  enableParanoid, disableParanoid, lock, getVaultSecrets, __resetVaultStateForTests,
} from '../../db/vault';
import type { Task } from '../../db/models';

const mockGetFile = getFile as Mock;
const mockPutFile = putFile as Mock;
const PASS = 'sync vault passphrase';

function seedTask() {
  const now = Date.now();
  return db.tasks.add({ id: 't1', listId: 'l1', title: 'x', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
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
