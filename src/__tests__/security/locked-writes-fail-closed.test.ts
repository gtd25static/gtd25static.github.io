import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { setMigrationBypass } from '../../db/vault-middleware';
import { enableParanoid, lock, __resetVaultStateForTests } from '../../db/vault';
import type { ChangeEntry, Task, TaskList } from '../../db/models';

// On a Paranoid device the at-rest middleware encrypts with the vault key — and
// used to pass writes through untouched when there was no key. Anything still
// running when the vault locked (a sync mid-pull, most obviously) then landed
// real content on disk in plaintext. Locked writes of content must fail closed.

const PASS = 'locked writes passphrase 42 quartz';

const task = (title: string): Task =>
  ({ id: 't1', listId: 'l1', title, status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);

async function rawTask(id: string): Promise<Record<string, unknown> | undefined> {
  setMigrationBypass(true);
  try {
    return (await db.tasks.get(id)) as unknown as Record<string, unknown> | undefined;
  } finally {
    setMigrationBypass(false);
  }
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('writes while the vault is locked', () => {
  it('refuses to store plaintext content', async () => {
    await enableParanoid(PASS);
    lock();

    await expect(db.tasks.put(task('REAL_TITLE'))).rejects.toThrow();
    expect(await rawTask('t1')).toBeUndefined();
  });

  it('refuses a plaintext changelog snapshot too', async () => {
    await enableParanoid(PASS);
    lock();

    const entry = {
      id: 'c1', deviceId: 'd', timestamp: 1, entityType: 'task', entityId: 't1',
      operation: 'upsert', data: { title: 'REAL_TITLE' }, v: 6,
    } as unknown as ChangeEntry;
    await expect(db.changeLog.add(entry)).rejects.toThrow();
    expect(await db.changeLog.count()).toBe(0);
  });

  it('still allows what a locked device legitimately does: deletes, and updates of encrypted rows', async () => {
    await db.taskLists.add({ id: 'l1', name: 'List', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
    await db.tasks.add(task('REAL_TITLE'));
    await enableParanoid(PASS); // the migration encrypts both rows
    lock();

    await db.tasks.update('t1', { deletedAt: 5 });
    const updated = await rawTask('t1');
    expect(updated?.deletedAt).toBe(5);
    expect(updated?._enc).toBeTruthy();

    await db.tasks.delete('t1');
    expect(await rawTask('t1')).toBeUndefined();
  });

  it('control: unlocked, the same write is encrypted', async () => {
    await enableParanoid(PASS);

    await db.tasks.put(task('REAL_TITLE'));
    const raw = await rawTask('t1');
    expect(raw?._enc).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain('REAL_TITLE');
  });

  it('control: without Paranoid Mode, plaintext writes are untouched', async () => {
    await db.tasks.put(task('REAL_TITLE'));
    expect((await db.tasks.get('t1'))?.title).toBe('REAL_TITLE');
  });
});
