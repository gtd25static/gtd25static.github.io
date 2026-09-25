import { db, ensureDefaults } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { purgeOldTrashItems, expireCompletedItems } from '../../db/purge';
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

// gtd25 is not an archive: completed tasks and resolved follow-ups leave 12
// months after they were done (to the Trash, where the 30-day purge above ends
// them), so lists can't grow for ever. Open items are never touched.
describe('expireCompletedItems', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date(2026, 8, 25, 12).getTime();
  const listId = 'work';
  const followUpListId = 'people';

  beforeEach(async () => {
    await db.taskLists.bulkAdd([
      { id: listId, name: 'Work', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 },
      { id: followUpListId, name: 'People', type: 'follow-ups', order: 1, createdAt: 1, updatedAt: 1 },
    ]);
  });

  const task = (id: string, fields: Record<string, unknown>) => ({
    id, listId, title: id, status: 'todo' as const, order: 0, createdAt: 1, updatedAt: 1, ...fields,
  });

  it('sends a task completed over 12 months ago to the Trash, with its subtasks', async () => {
    await db.tasks.add(task('old-done', { status: 'done', completedAt: now - 370 * DAY, updatedAt: now - 370 * DAY }));
    await db.subtasks.add({ id: 'old-sub', taskId: 'old-done', title: 's', status: 'done', order: 0, createdAt: 1, updatedAt: 1 });

    await expireCompletedItems(now);

    expect((await db.tasks.get('old-done'))?.deletedAt).toBe(now);
    expect((await db.subtasks.get('old-sub'))?.deletedAt).toBe(now);
    const logged = (await db.changeLog.toArray()).map((e) => [e.entityId, e.operation]);
    expect(logged).toEqual(expect.arrayContaining([['old-done', 'delete'], ['old-sub', 'delete']]));
  });

  it('counts from completion, not from the last edit', async () => {
    await db.tasks.add(task('edited', { status: 'done', completedAt: now - 370 * DAY, updatedAt: now - DAY }));
    await expireCompletedItems(now);
    expect((await db.tasks.get('edited'))?.deletedAt).toBe(now);
  });

  it('keeps what was completed within 12 months, and every open task however old', async () => {
    await db.tasks.bulkAdd([
      task('recent-done', { status: 'done', completedAt: now - 300 * DAY }),
      task('ancient-open', { createdAt: now - 1000 * DAY, updatedAt: now - 1000 * DAY }),
      task('ancient-blocked', { status: 'blocked', createdAt: now - 1000 * DAY, updatedAt: now - 1000 * DAY }),
    ]);
    const changesBefore = await db.changeLog.count();

    await expireCompletedItems(now);

    for (const id of ['recent-done', 'ancient-open', 'ancient-blocked']) {
      expect((await db.tasks.get(id))?.deletedAt, id).toBeUndefined();
    }
    expect(await db.changeLog.count()).toBe(changesBefore);
  });

  it('uses updatedAt for an old row without a completion time', async () => {
    await db.tasks.add(task('legacy', { status: 'done', updatedAt: now - 400 * DAY }));
    await expireCompletedItems(now);
    expect((await db.tasks.get('legacy'))?.deletedAt).toBe(now);
  });

  it('sends a follow-up resolved over 12 months ago to the Trash, and keeps the rest', async () => {
    await db.tasks.bulkAdd([
      { ...task('old-resolved', { archived: true, updatedAt: now - 400 * DAY, fieldTimestamps: { archived: now - 400 * DAY } }), listId: followUpListId },
      { ...task('recent-resolved', { archived: true, updatedAt: now - 10 * DAY, fieldTimestamps: { archived: now - 10 * DAY } }), listId: followUpListId },
      { ...task('old-open-topic', { createdAt: now - 900 * DAY, updatedAt: now - 900 * DAY }), listId: followUpListId },
    ]);

    await expireCompletedItems(now);

    expect((await db.tasks.get('old-resolved'))?.deletedAt).toBe(now);
    expect((await db.tasks.get('recent-resolved'))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get('old-open-topic'))?.deletedAt).toBeUndefined();
  });

  it('leaves what is already in the Trash as it is', async () => {
    await db.tasks.add(task('trashed', { status: 'done', completedAt: now - 400 * DAY, deletedAt: now - 5 * DAY }));
    await expireCompletedItems(now);
    expect((await db.tasks.get('trashed'))?.deletedAt).toBe(now - 5 * DAY);
  });

  it('runs at every start', async () => {
    const realNow = Date.now();
    await db.tasks.add(task('from-last-year', { status: 'done', completedAt: realNow - 400 * DAY }));
    await ensureDefaults();
    expect((await db.tasks.get('from-last-year'))?.deletedAt).toBeGreaterThan(0);
  });
});
