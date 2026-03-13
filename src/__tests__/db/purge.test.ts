import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { purgeOldTrashItems } from '../../db/purge';
import { newId } from '../../lib/id';

beforeEach(async () => {
  await resetDb();
});

const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000;
const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000;

describe('purgeOldTrashItems', () => {
  it('hard-deletes items deleted >30 days ago', async () => {
    const now = Date.now();
    const listId = newId();
    const taskId = newId();
    const subId = newId();

    await db.taskLists.add({ id: listId, name: 'Old', type: 'tasks', order: 0, createdAt: 1000, updatedAt: 1000, deletedAt: now - THIRTY_ONE_DAYS });
    await db.tasks.add({ id: taskId, listId, title: 'Old Task', status: 'todo', order: 0, createdAt: 1000, updatedAt: 1000, deletedAt: now - THIRTY_ONE_DAYS });
    await db.subtasks.add({ id: subId, taskId, title: 'Old Sub', status: 'todo', order: 0, createdAt: 1000, updatedAt: 1000, deletedAt: now - THIRTY_ONE_DAYS });

    await purgeOldTrashItems();

    expect(await db.taskLists.get(listId)).toBeUndefined();
    expect(await db.tasks.get(taskId)).toBeUndefined();
    expect(await db.subtasks.get(subId)).toBeUndefined();
  });

  it('keeps recently deleted items', async () => {
    const now = Date.now();
    const listId = newId();

    await db.taskLists.add({ id: listId, name: 'Recent', type: 'tasks', order: 0, createdAt: 1000, updatedAt: 1000, deletedAt: now - FIVE_DAYS });

    await purgeOldTrashItems();

    expect(await db.taskLists.get(listId)).toBeDefined();
  });

  it('keeps non-deleted items', async () => {
    const listId = newId();
    await db.taskLists.add({ id: listId, name: 'Active', type: 'tasks', order: 0, createdAt: 1000, updatedAt: 1000 });

    await purgeOldTrashItems();

    expect(await db.taskLists.get(listId)).toBeDefined();
  });

  it('handles empty database without error', async () => {
    // Should not throw
    await purgeOldTrashItems();
  });
});
