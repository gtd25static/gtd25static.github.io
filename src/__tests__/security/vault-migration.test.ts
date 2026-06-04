import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, disableParanoid, unlockWithPassphrase, lock,
  isParanoidEnabled, isUnlocked, __resetVaultStateForTests,
} from '../../db/vault';
import { setMigrationBypass } from '../../db/vault-middleware';
import type { Task, TaskList, Subtask } from '../../db/models';

const PASSPHRASE = 'a strong passphrase';

function seedTask(id: string, title: string): Task {
  const now = Date.now();
  return { id, listId: 'l1', title, description: `${title} desc`, status: 'todo', order: 1, createdAt: now, updatedAt: now };
}

async function rawTitle(id: string): Promise<unknown> {
  // Bypass = middleware passthrough, so we read exactly what is on disk.
  setMigrationBypass(true);
  try {
    return (await db.tasks.get(id))?.title;
  } finally {
    setMigrationBypass(false);
  }
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  await db.taskLists.add({ id: 'l1', name: 'List One', type: 'tasks', order: 1, createdAt: 1, updatedAt: 1 } as TaskList);
  await db.tasks.bulkAdd([seedTask('t1', 'alpha'), seedTask('t2', 'bravo')]);
  await db.subtasks.add({ id: 's1', taskId: 't1', title: 'sub one', status: 'todo', order: 1, createdAt: 1, updatedAt: 1 } as Subtask);
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('enable migration on existing data', () => {
  it('encrypts all pre-existing rows and leaves them readable', async () => {
    await enableParanoid(PASSPHRASE);

    expect(isParanoidEnabled()).toBe(true);
    expect(isUnlocked()).toBe(true);

    // Decrypted reads still work (DEK active).
    const tasks = await db.tasks.toArray();
    expect(tasks.map((t) => t.title).sort()).toEqual(['alpha', 'bravo']);
    expect((await db.taskLists.get('l1'))?.name).toBe('List One');
    expect((await db.subtasks.get('s1'))?.title).toBe('sub one');

    // The vault row records completion and credentials.
    const vault = await db.vault.get('vault');
    expect(vault?.migrationState).toBe('done');
    expect(vault?.secrets).toBeTruthy();
  });

  it('disables and decrypts back to plaintext on disk', async () => {
    await enableParanoid(PASSPHRASE);
    await disableParanoid();

    expect(isParanoidEnabled()).toBe(false);
    expect(isUnlocked()).toBe(false);
    expect(await db.vault.get('vault')).toBeUndefined();

    // Rows are plaintext on disk again.
    expect(await rawTitle('t1')).toBe('alpha');
    const tasks = await db.tasks.toArray();
    expect(tasks.map((t) => t.title).sort()).toEqual(['alpha', 'bravo']);
  });

  it('unlock after lock restores access; wrong passphrase fails', async () => {
    await enableParanoid(PASSPHRASE);
    lock();
    expect(isUnlocked()).toBe(false);

    expect(await unlockWithPassphrase('nope')).toBe(false);
    expect(isUnlocked()).toBe(false);

    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
    expect(isUnlocked()).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe('alpha');
  });

  it('resumes an interrupted enable migration on next unlock', async () => {
    await enableParanoid(PASSPHRASE);
    // Simulate a crash mid-encrypt: mark state back to encrypting and lock.
    await db.vault.update('vault', { migrationState: 'encrypting' });
    lock();

    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
    expect((await db.vault.get('vault'))?.migrationState).toBe('done');
    expect((await db.tasks.get('t2'))?.title).toBe('bravo');
  });

  it('completes an interrupted disable migration on next unlock', async () => {
    await enableParanoid(PASSPHRASE);
    await db.vault.update('vault', { migrationState: 'decrypting' });
    lock();

    expect(await unlockWithPassphrase(PASSPHRASE)).toBe(true);
    expect(isParanoidEnabled()).toBe(false);
    expect(await db.vault.get('vault')).toBeUndefined();
    expect(await rawTitle('t1')).toBe('alpha');
  });
});
