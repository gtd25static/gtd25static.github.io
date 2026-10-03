import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { setMigrationBypass } from '../../db/vault-middleware';
import { enableParanoid, lock, unlockWithPassphrase, __resetVaultStateForTests } from '../../db/vault';
import { pruneChangelogIfSyncDisabled } from '../../sync/change-log';
import type { ChangeEntry, Task, TaskList } from '../../db/models';

// Threat-model review, batch 5.
//  - Rows not rewritten since SYNC_VERSION 7 kept `fieldTimestamps` (which fields
//    exist, when each changed) in plaintext beside their ciphertext; and a row a
//    forged `_enc` had left in plaintext (fixed in batch 1) stayed so until edited.
//    The first unlock after the update rewrites every such row once.
//  - With sync off the changelog kept up to 10,000 full past versions of every
//    record — "deleted forever" ones included.

const PASS = 'hygiene passphrase 6 lantern';

async function raw<T>(fn: () => Promise<T>): Promise<T> {
  setMigrationBypass(true);
  try { return await fn(); } finally { setMigrationBypass(false); }
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

describe('the first unlock after the update rewrites old at-rest rows once', () => {
  it('moves a top-level fieldTimestamps inside, and re-encrypts a row left in plaintext', async () => {
    await db.taskLists.add({ id: 'l1', name: 'Work', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
    await db.tasks.bulkAdd([
      { id: 't1', listId: 'l1', title: 'old row', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task,
      { id: 't2', listId: 'l1', title: 'other', status: 'todo', order: 1, createdAt: 1, updatedAt: 1 } as Task,
    ]);
    await enableParanoid(PASS);
    // As an older build left them: fieldTimestamps beside the ciphertext, and a
    // row with a forged non-string `_enc` beside its real content.
    await raw(async () => {
      const t1 = (await db.tasks.get('t1')) as unknown as Record<string, unknown>;
      await db.tasks.put({ ...t1, fieldTimestamps: { title: 5, description: 6 } } as unknown as Task);
      await db.tasks.put({ id: 't2', listId: 'l1', title: 'FIRE_THE_CFO', status: 'todo', order: 1, createdAt: 1, updatedAt: 1, _enc: 1 } as unknown as Task);
    });
    await db.localSettings.update('local', { atRestRewrittenAt: undefined });
    lock();
    expect(await unlockWithPassphrase(PASS)).toBe(true);

    const [t1, t2] = await raw(async () => [await db.tasks.get('t1'), await db.tasks.get('t2')] as unknown as Array<Record<string, unknown>>);
    expect('fieldTimestamps' in t1).toBe(false);
    expect(typeof t2._enc).toBe('string');
    expect(JSON.stringify(t2)).not.toContain('FIRE_THE_CFO');
    expect((await db.tasks.get('t1'))?.fieldTimestamps).toEqual(expect.objectContaining({ title: 5, description: 6 }));
    expect((await db.tasks.get('t2'))?.title).toBe('FIRE_THE_CFO');
    expect((await db.localSettings.get('local'))?.atRestRewrittenAt).toBeGreaterThan(0);
  });
});

describe('the changelog while sync is off', () => {
  function entry(entityId: string, timestamp: number, operation: 'upsert' | 'delete' = 'upsert', title = 'x'): ChangeEntry {
    return { id: `${entityId}-${timestamp}`, deviceId: 'd', timestamp, entityType: 'task', entityId, operation,
      data: operation === 'upsert' ? { id: entityId, listId: 'l1', title, status: 'todo', order: 0, createdAt: 1, updatedAt: timestamp } : undefined };
  }

  it('keeps one entry per record, and none for records gone for good', async () => {
    await db.localSettings.update('local', { syncEnabled: false });
    await db.tasks.add({ id: 'a', listId: 'l1', title: 'now', status: 'todo', order: 0, createdAt: 1, updatedAt: 3 } as Task);
    await db.changeLog.bulkAdd([
      entry('a', 1, 'upsert', 'OLD SECRET v1'), entry('a', 2, 'upsert', 'OLD SECRET v2'), entry('a', 3, 'upsert', 'now'),
      entry('purged', 4, 'upsert', 'DELETED FOREVER'), entry('purged', 5, 'delete'),
    ]);
    await pruneChangelogIfSyncDisabled();
    const left = await db.changeLog.toArray();
    expect(left.map((e) => e.id)).toEqual(['a-3']);
    expect(JSON.stringify(left)).not.toMatch(/OLD SECRET|DELETED FOREVER/);
  });

  it('leaves the changelog alone while sync is on', async () => {
    await db.localSettings.update('local', { syncEnabled: true });
    await db.changeLog.bulkAdd([entry('a', 1), entry('a', 2)]);
    await pruneChangelogIfSyncDisabled();
    expect(await db.changeLog.count()).toBe(2);
  });
});
