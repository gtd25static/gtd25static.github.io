import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, lock, __resetVaultStateForTests } from '../../db/vault';
import { hasPendingWorkLocked } from '../../hooks/use-nudges';
import type { Task, TaskList } from '../../db/models';

const PASS = 'locked nudge passphrase';

function task(id: string, extra: Partial<Task>): Task {
  const now = Date.now();
  return { id, listId: 'l1', title: 'secret', status: 'todo', order: 1, createdAt: now, updatedAt: now, ...extra } as Task;
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  await db.taskLists.add({ id: 'l1', name: 'List', type: 'tasks', order: 1, createdAt: 1, updatedAt: 1 } as TaskList);
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('locked generic nudge — metadata-only pending-work check', () => {
  it('detects due work while LOCKED without reading titles (no crash)', async () => {
    const now = Date.now();
    await db.tasks.add(task('t1', { dueDate: now }));
    await enableParanoid(PASS);
    lock();

    // While locked, the title is NOT readable (encrypted) but metadata is.
    const raw = await db.tasks.get('t1');
    expect(raw?.title).toBeUndefined();
    expect(raw?.dueDate).toBe(now);

    expect(await hasPendingWorkLocked(now)).toBe(true);
  });

  it('returns false when there is no due/overdue work', async () => {
    const now = Date.now();
    await db.tasks.add(task('t2', {})); // no dueDate
    await enableParanoid(PASS);
    lock();
    expect(await hasPendingWorkLocked(now)).toBe(false);
  });

  it('ignores done / blocked / deleted tasks', async () => {
    const now = Date.now();
    await db.tasks.bulkAdd([
      task('d1', { status: 'done', dueDate: now }),
      task('d2', { status: 'blocked', dueDate: now }),
      task('d3', { deletedAt: now, dueDate: now }),
    ]);
    await enableParanoid(PASS);
    lock();
    expect(await hasPendingWorkLocked(now)).toBe(false);
  });
});
