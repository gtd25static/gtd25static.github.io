import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });

// Mock the GitHub transport so we can assert whether the remote-backup path
// ever reaches out to the network.
vi.mock('../../sync/github-api', () => ({ getFile: vi.fn(), putFile: vi.fn() }));

import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { createLocalBackup } from '../../db/backup';
import { maybeCreateBackups, __resetForTesting } from '../../sync/remote-backups';
import { getFile, putFile } from '../../sync/github-api';
import type { Task } from '../../db/models';

const PARANOID_FLAG = 'gtd25-paranoid';

function localBackupKeys(): string[] {
  // The test localStorage polyfill doesn't enumerate stored keys via Object.keys;
  // use the index API which works there and in real browsers.
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('gtd25-local-backup-')) keys.push(k);
  }
  return keys;
}

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

beforeEach(async () => {
  await resetDb();
  localStorage.clear();
  vi.clearAllMocks();
  __resetForTesting();
  const now = Date.now();
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'x', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('paranoid devices create no backups', () => {
  it('creates a local backup when paranoid is OFF', async () => {
    await createLocalBackup();
    expect(localBackupKeys().length).toBe(1);
  });

  it('creates NO local backup when paranoid is ON', async () => {
    localStorage.setItem(PARANOID_FLAG, '1');
    await createLocalBackup();
    expect(localBackupKeys().length).toBe(0);
  });

  it('makes no remote backup network calls when paranoid is ON', async () => {
    localStorage.setItem(PARANOID_FLAG, '1');
    await maybeCreateBackups('pat', 'owner/repo', await aesKey());
    expect(getFile).not.toHaveBeenCalled();
    expect(putFile).not.toHaveBeenCalled();
  });

  it('still checks remote backups when paranoid is OFF', async () => {
    // Skip the anti-thundering-herd jitter so the test is fast & deterministic.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as typeof setTimeout);
    // Remote already fresh for every tier -> the function checks but writes nothing.
    vi.mocked(getFile).mockResolvedValue({ data: JSON.stringify({ backedUpAt: Date.now() }), sha: 'sha' });

    await maybeCreateBackups('pat', 'owner/repo', await aesKey());

    expect(getFile).toHaveBeenCalled();        // did NOT short-circuit
    expect(putFile).not.toHaveBeenCalled();     // nothing stale to write
  });
});
