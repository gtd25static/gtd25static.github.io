import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, lock, verifyAtRestIntegrity, __resetVaultStateForTests } from '../../db/vault';
import { setMigrationBypass } from '../../db/vault-middleware';
import type { Task, TaskList } from '../../db/models';

const PASS = 'integrity passphrase';

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  await db.taskLists.add({ id: 'l1', name: 'L', type: 'tasks', order: 1, createdAt: 1, updatedAt: 1 } as TaskList);
  const now = Date.now();
  await db.tasks.bulkAdd([
    { id: 't1', listId: 'l1', title: 'a', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task,
    { id: 't2', listId: 'l1', title: 'b', status: 'todo', order: 2, createdAt: now, updatedAt: now } as Task,
  ]);
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('verifyAtRestIntegrity', () => {
  it('reports all readable on a healthy vault', async () => {
    await enableParanoid(PASS);
    const r = await verifyAtRestIntegrity();
    expect(r).toEqual({ total: 3, unreadable: 0 }); // 1 list + 2 tasks
  });

  it('counts a corrupted row as unreadable', async () => {
    await enableParanoid(PASS);
    setMigrationBypass(true);
    try {
      const raw = (await db.tasks.get('t2')) as unknown as Record<string, unknown>;
      await db.tasks.put({ ...raw, _enc: btoa('x'.repeat(40)) } as unknown as Task);
    } finally {
      setMigrationBypass(false);
    }
    const r = await verifyAtRestIntegrity();
    expect(r.total).toBe(3);
    expect(r.unreadable).toBe(1);
  });

  it('throws when the vault is locked', async () => {
    await enableParanoid(PASS);
    lock();
    await expect(verifyAtRestIntegrity()).rejects.toThrow(/Unlock the vault/);
  });
});
