import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { setMigrationBypass } from '../../db/vault-middleware';
import {
  enableParanoid, unlockWithPassphrase, lock, isParanoidEnabled, isUnlocked,
  getVaultSecrets, reconcileParanoidFlag, __resetVaultStateForTests,
} from '../../db/vault';
import { createLocalBackup, getLocalBackups } from '../../db/backup';
import type { Task, TaskList, Subtask } from '../../db/models';

// An enable that doesn't run to completion (tab closed, crash, storage full)
// must never leave the device looking un-Paranoid over half-encrypted rows, and
// must never be "fixed" by an enable that mints a new key over the old one — that
// used to destroy every row the first attempt had already encrypted.

const PASS = 'the real passphrase 123';
const FLAG = 'gtd25-paranoid';

async function seed() {
  await db.taskLists.add({ id: 'l1', name: 'LIST_MARKER', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'TASK_MARKER', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);
  await db.subtasks.add({ id: 's1', taskId: 't1', title: 'SUB_MARKER', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Subtask);
  await db.localSettings.put({ id: 'local', syncEnabled: true, syncIntervalMs: 300_000, githubPat: 'ghp_PAT_MARKER', encryptionPassword: 'SYNCPW_MARKER' });
}

/** Enable, with the tab "closed" while the tasks table is being rewritten encrypted. */
async function enableCrashingMidway(): Promise<void> {
  const spy = vi.spyOn(db.tasks, 'bulkPut').mockRejectedValueOnce(new Error('tab closed'));
  await enableParanoid(PASS).catch(() => undefined);
  spy.mockRestore();
}

/** What a reload does to this module: the in-memory key is gone; disk stays. */
async function reload(): Promise<void> {
  __resetVaultStateForTests();
  await reconcileParanoidFlag(); // main.tsx runs this before the first render
}

async function rawRows(): Promise<string> {
  setMigrationBypass(true);
  try {
    return JSON.stringify([await db.taskLists.toArray(), await db.tasks.toArray(), await db.subtasks.toArray()]);
  } finally {
    setMigrationBypass(false);
  }
}

async function expectRealContentReadable() {
  expect((await db.taskLists.get('l1'))?.name).toBe('LIST_MARKER');
  expect((await db.tasks.get('t1'))?.title).toBe('TASK_MARKER');
  expect((await db.subtasks.get('s1'))?.title).toBe('SUB_MARKER');
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.clear();
  await seed();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetVaultStateForTests();
  localStorage.clear();
});

describe('an enable interrupted mid-encryption', () => {
  it('leaves the device Paranoid, so it comes back to the lock screen', async () => {
    await enableCrashingMidway();
    await reload();
    expect(isParanoidEnabled()).toBe(true);
    expect(isUnlocked()).toBe(false);
    expect((await db.vault.get('vault'))?.migrationState).toBe('encrypting');
  });

  it('finishes on the next unlock: everything readable, and encrypted on disk', async () => {
    await enableCrashingMidway();
    await reload();

    expect(await unlockWithPassphrase(PASS)).toBe(true);

    await expectRealContentReadable();
    expect((await db.vault.get('vault'))?.migrationState).toBe('done');
    expect(await rawRows()).not.toMatch(/LIST_MARKER|TASK_MARKER|SUB_MARKER/);
  });

  it('finishes the rest of the enable too: credentials moved into the vault', async () => {
    await enableCrashingMidway();
    await reload();
    await unlockWithPassphrase(PASS);

    const local = await db.localSettings.get('local');
    expect(local?.githubPat).toBeUndefined();
    expect(local?.encryptionPassword).toBeUndefined();
    expect(local?.paranoidEnabled).toBe(true);
    expect(getVaultSecrets()).toEqual({ githubPat: 'ghp_PAT_MARKER', syncPassword: 'SYNCPW_MARKER' });
  });

  it('keeps the plaintext safety backups until the encryption completes, then deletes them', async () => {
    await createLocalBackup();
    expect(getLocalBackups()).toHaveLength(1);

    await enableCrashingMidway();
    expect(getLocalBackups(), 'a recovery point while the migration is unfinished').toHaveLength(1);

    await reload();
    await unlockWithPassphrase(PASS);
    const leftovers = getLocalBackups().map((b) => localStorage.getItem(b.key) ?? '');
    expect(leftovers.join(' ')).not.toMatch(/TASK_MARKER/);
  });

  it('refuses plaintext writes while it waits locked (fail-closed like any Paranoid device)', async () => {
    await enableCrashingMidway();
    await reload();
    await expect(db.tasks.put({ id: 't9', listId: 'l1', title: 'LEAK', status: 'todo', order: 9, createdAt: 1, updatedAt: 1 } as Task))
      .rejects.toThrow(/locked/i);
  });
});

describe('enabling again over an unfinished enable', () => {
  it('is refused instead of replacing the vault (and its key)', async () => {
    await enableCrashingMidway();
    const vaultBefore = await db.vault.get('vault');
    __resetVaultStateForTests();
    localStorage.removeItem(FLAG); // worst case: the flag never made it to disk

    await expect(enableParanoid(PASS)).rejects.toThrow(/unfinished|unlock/i);
    expect(await db.vault.get('vault')).toEqual(vaultBefore);
  });

  it('the data encrypted by the first attempt is still recoverable afterwards', async () => {
    await enableCrashingMidway();
    __resetVaultStateForTests();
    localStorage.removeItem(FLAG);
    await enableParanoid(PASS).catch(() => undefined);

    await reload();
    expect(await unlockWithPassphrase(PASS)).toBe(true);
    await expectRealContentReadable();
  });
});

describe('an enable that throws after the key was saved (e.g. storage full)', () => {
  it('reports that it will resume, stays Paranoid, and completes on the next unlock', async () => {
    const spy = vi.spyOn(db.tasks, 'bulkPut').mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    await expect(enableParanoid(PASS)).rejects.toThrow(/resume.*unlock/i);
    spy.mockRestore();
    expect(isParanoidEnabled()).toBe(true);

    lock();
    expect(await unlockWithPassphrase(PASS)).toBe(true);
    await expectRealContentReadable();
    expect((await db.vault.get('vault'))?.migrationState).toBe('done');
  });
});

describe('reconcileParanoidFlag (boot)', () => {
  it('sets the flag for a vault saved just before the tab died', async () => {
    await enableParanoid(PASS);
    localStorage.removeItem(FLAG);
    await reload();
    expect(isParanoidEnabled()).toBe(true);
    expect(await unlockWithPassphrase(PASS)).toBe(true);
    await expectRealContentReadable();
  });

  it('clears a flag left behind by a disable that deleted the vault just before the tab died', async () => {
    localStorage.setItem(FLAG, '1');
    expect(await db.vault.get('vault')).toBeUndefined();
    await reload();
    expect(isParanoidEnabled()).toBe(false);
    expect((await db.tasks.get('t1'))?.title).toBe('TASK_MARKER');
  });

  it('leaves consistent states alone', async () => {
    await reload();
    expect(isParanoidEnabled()).toBe(false);

    await enableParanoid(PASS);
    await reload();
    expect(isParanoidEnabled()).toBe(true);
  });
});
