import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { normaliseWarningsInStore } from '../../db/warning-index';

// Attention finds warnings through the hasWarning index, and IndexedDB can't
// index booleans: every warning written as `true` was invisible to it for months.

beforeEach(async () => {
  await resetDb();
});

describe('warning index', () => {
  it('stores a `true` warning as 1, whatever wrote it, so the index sees it', async () => {
    const now = Date.now();
    // e.g. a snapshot or change entry from an older build or device
    await db.tasks.bulkPut([
      { id: 't1', listId: 'l', title: 'Warned', status: 'todo', order: 0, createdAt: now, updatedAt: now, hasWarning: true },
      { id: 't2', listId: 'l', title: 'Calm', status: 'todo', order: 1, createdAt: now, updatedAt: now },
    ]);
    await db.subtasks.put({ id: 's1', taskId: 't2', title: 'Warned sub', status: 'todo', order: 0, createdAt: now, updatedAt: now, hasWarning: true });

    expect((await db.tasks.where('hasWarning').equals(1).toArray()).map((t) => t.id)).toEqual(['t1']);
    expect((await db.subtasks.where('hasWarning').equals(1).toArray()).map((s) => s.id)).toEqual(['s1']);
  });

  it('the one-time upgrade rewrites stored `true` warnings as 1 and leaves everything else as it was', async () => {
    const name = `warning-upgrade-${Math.random()}`;
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('tasks', { keyPath: 'id' });
    const idb: IDBDatabase = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result); });
    const encrypted = { id: 'e', _enc: 'ciphertext', status: 'todo', hasWarning: true };
    await new Promise<void>((resolve) => {
      const tx = idb.transaction('tasks', 'readwrite');
      tx.objectStore('tasks').put(encrypted);
      tx.objectStore('tasks').put({ id: 'p', title: 'plain', hasWarning: true });
      tx.objectStore('tasks').put({ id: 'n', title: 'none' });
      tx.oncomplete = () => resolve();
    });

    const tx = idb.transaction('tasks', 'readwrite');
    await normaliseWarningsInStore(tx.objectStore('tasks'));
    const rows: Record<string, unknown>[] = await new Promise((resolve) => {
      const req = tx.objectStore('tasks').getAll();
      req.onsuccess = () => resolve(req.result);
    });
    idb.close();

    expect(rows).toEqual([
      { ...encrypted, hasWarning: 1 },
      { id: 'n', title: 'none' },
      { id: 'p', title: 'plain', hasWarning: 1 },
    ]);
  });
});
