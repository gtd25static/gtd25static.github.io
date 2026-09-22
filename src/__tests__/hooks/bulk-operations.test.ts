import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, setTaskStatus, updateTask } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';
import { deleteTasksBatch, setTaskStatusBatch, moveTasksToListBatch } from '../../hooks/use-bulk-operations';

let listId: string;

beforeEach(async () => {
  await resetDb();
  const list = await createTaskList('Test List');
  listId = list.id;
});

describe('deleteTasksBatch', () => {
  it('soft-deletes multiple tasks', async () => {
    const t1 = assertDefined(await createTask(listId, { title: 'Task 1' }));
    const t2 = assertDefined(await createTask(listId, { title: 'Task 2' }));
    const t3 = assertDefined(await createTask(listId, { title: 'Task 3' }));

    await deleteTasksBatch([t1.id, t3.id]);

    const d1 = await db.tasks.get(t1.id);
    const d2 = await db.tasks.get(t2.id);
    const d3 = await db.tasks.get(t3.id);
    expect(d1?.deletedAt).toBeDefined();
    expect(d2?.deletedAt).toBeUndefined();
    expect(d3?.deletedAt).toBeDefined();
  });

  it('cascades delete to subtasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    await createSubtask(task.id, { title: 'Sub 1' });
    await createSubtask(task.id, { title: 'Sub 2' });

    await deleteTasksBatch([task.id]);

    const subs = await db.subtasks.where('taskId').equals(task.id).toArray();
    expect(subs.every((s) => s.deletedAt !== undefined)).toBe(true);
  });

  it('records changes in changelog', async () => {
    const t1 = assertDefined(await createTask(listId, { title: 'Task 1' }));
    const t2 = assertDefined(await createTask(listId, { title: 'Task 2' }));
    const beforeCount = await db.changeLog.count();

    await deleteTasksBatch([t1.id, t2.id]);

    const afterCount = await db.changeLog.count();
    expect(afterCount).toBeGreaterThan(beforeCount);
    const entries = await db.changeLog.toArray();
    const deleteEntries = entries.filter((e) => e.operation === 'delete' && e.entityType === 'task');
    expect(deleteEntries.length).toBeGreaterThanOrEqual(2);
  });

  it('handles empty array gracefully', async () => {
    await deleteTasksBatch([]);
    // Should not throw
  });
});

describe('setTaskStatusBatch', () => {
  it('sets multiple tasks to done', async () => {
    const t1 = assertDefined(await createTask(listId, { title: 'Task 1' }));
    const t2 = assertDefined(await createTask(listId, { title: 'Task 2' }));

    await setTaskStatusBatch([t1.id, t2.id], 'done');

    const u1 = await db.tasks.get(t1.id);
    const u2 = await db.tasks.get(t2.id);
    expect(u1?.status).toBe('done');
    expect(u2?.status).toBe('done');
    expect(u1?.completedAt).toBeDefined();
    expect(u2?.completedAt).toBeDefined();
  });

  it('sets multiple tasks to blocked with blockedAt', async () => {
    const t1 = assertDefined(await createTask(listId, { title: 'Task 1' }));
    const t2 = assertDefined(await createTask(listId, { title: 'Task 2' }));

    await setTaskStatusBatch([t1.id, t2.id], 'blocked');

    const u1 = await db.tasks.get(t1.id);
    const u2 = await db.tasks.get(t2.id);
    expect(u1?.status).toBe('blocked');
    expect(u2?.status).toBe('blocked');
    expect(u1?.blockedAt).toBeDefined();
    expect(u2?.blockedAt).toBeDefined();
  });

  it('clears blockedAt when unblocking', async () => {
    const t1 = assertDefined(await createTask(listId, { title: 'Task 1' }));
    await setTaskStatusBatch([t1.id], 'blocked');
    const blocked = await db.tasks.get(t1.id);
    expect(blocked?.blockedAt).toBeDefined();

    await setTaskStatusBatch([t1.id], 'todo');
    const unblocked = await db.tasks.get(t1.id);
    expect(unblocked?.status).toBe('todo');
    expect(unblocked?.blockedAt).toBeUndefined();
  });

  it('handles empty array gracefully', async () => {
    await setTaskStatusBatch([], 'done');
  });
});

describe('moveTasksToListBatch', () => {
  it('moves multiple tasks to target list', async () => {
    const targetList = await createTaskList('Target');
    const t1 = assertDefined(await createTask(listId, { title: 'Task 1' }));
    const t2 = assertDefined(await createTask(listId, { title: 'Task 2' }));

    await moveTasksToListBatch([t1.id, t2.id], targetList.id);

    const u1 = await db.tasks.get(t1.id);
    const u2 = await db.tasks.get(t2.id);
    expect(u1?.listId).toBe(targetList.id);
    expect(u2?.listId).toBe(targetList.id);
  });

  it('assigns sequential order starting from existing count', async () => {
    const targetList = await createTaskList('Target');
    // Create an existing task in target
    await createTask(targetList.id, { title: 'Existing' });

    const t1 = assertDefined(await createTask(listId, { title: 'Task 1' }));
    const t2 = assertDefined(await createTask(listId, { title: 'Task 2' }));

    await moveTasksToListBatch([t1.id, t2.id], targetList.id);

    const u1 = await db.tasks.get(t1.id);
    const u2 = await db.tasks.get(t2.id);
    expect(u1?.order).toBe(1);
    expect(u2?.order).toBe(2);
  });

  it('records changes in changelog', async () => {
    const targetList = await createTaskList('Target');
    const t1 = assertDefined(await createTask(listId, { title: 'Task 1' }));
    const beforeCount = await db.changeLog.count();

    await moveTasksToListBatch([t1.id], targetList.id);

    const afterCount = await db.changeLog.count();
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it('handles empty array gracefully', async () => {
    const targetList = await createTaskList('Target');
    await moveTasksToListBatch([], targetList.id);
  });
});

describe('moveTasksToListBatch across list types', () => {
  let followUpListId: string;

  beforeEach(async () => {
    followUpListId = (await createTaskList('People', 'follow-ups')).id;
  });

  it('translates state like a single move: blocked lifted, done resolved, recurrence dropped', async () => {
    const blocked = assertDefined(await createTask(listId, { title: 'Blocked' }));
    await setTaskStatus(blocked.id, 'blocked');
    const done = assertDefined(await createTask(listId, { title: 'Done' }));
    await setTaskStatus(done.id, 'done');
    const weekly = assertDefined(await createTask(listId, {
      title: 'Weekly', recurrenceType: 'time-based', recurrenceInterval: 1, recurrenceUnit: 'weeks', nextOccurrence: Date.now() - 1000,
    }));

    expect(await moveTasksToListBatch([blocked.id, done.id, weekly.id], followUpListId)).toEqual({ moved: 3, skipped: 0 });

    const b = assertDefined(await db.tasks.get(blocked.id));
    expect(b.listId).toBe(followUpListId);
    expect(b.status).toBe('todo');
    expect(b.blockedAt).toBeUndefined();
    expect(b.fieldTimestamps?.status).toBe(b.updatedAt);
    expect(b.fieldTimestamps?.blockedAt).toBe(b.updatedAt);

    const d = assertDefined(await db.tasks.get(done.id));
    expect(d.archived).toBe(true);
    expect(d.status).toBe('todo');

    const w = assertDefined(await db.tasks.get(weekly.id));
    expect(w.recurrenceType).toBeUndefined();
    expect(w.nextOccurrence).toBeUndefined();
    expect(w.fieldTimestamps?.recurrenceType).toBe(w.updatedAt);
  });

  it('keeps content across the move', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Ask Ana', description: 'budget', links: [{ url: 'https://x.com' }] }));
    await updateTask(task.id, { starred: true });

    await moveTasksToListBatch([task.id], followUpListId);

    const moved = assertDefined(await db.tasks.get(task.id));
    expect(moved.title).toBe('Ask Ana');
    expect(moved.description).toBe('budget');
    expect(moved.links).toEqual([{ url: 'https://x.com' }]);
    expect(moved.starred).toBe(true);
  });

  it('skips tasks with subtasks and reports them, moving the rest', async () => {
    const parent = assertDefined(await createTask(listId, { title: 'Parent' }));
    await createSubtask(parent.id, { title: 'Child' });
    const plain = assertDefined(await createTask(listId, { title: 'Plain' }));

    expect(await moveTasksToListBatch([parent.id, plain.id], followUpListId)).toEqual({ moved: 1, skipped: 1 });

    expect((await db.tasks.get(parent.id))?.listId).toBe(listId);
    expect((await db.tasks.get(plain.id))?.listId).toBe(followUpListId);
  });

  it('writes nothing for a skipped task', async () => {
    const parent = assertDefined(await createTask(listId, { title: 'Parent' }));
    await createSubtask(parent.id, { title: 'Child' });
    const before = await db.tasks.get(parent.id);
    const changesBefore = await db.changeLog.count();

    expect(await moveTasksToListBatch([parent.id], followUpListId)).toEqual({ moved: 0, skipped: 1 });

    expect(await db.tasks.get(parent.id)).toEqual(before);
    expect(await db.changeLog.count()).toBe(changesBefore);
  });

  it('keeps the moved tasks contiguous at the end of the target list', async () => {
    await createTask(followUpListId, { title: 'Existing' });
    const a = assertDefined(await createTask(listId, { title: 'A' }));
    const parent = assertDefined(await createTask(listId, { title: 'Parent' }));
    await createSubtask(parent.id, { title: 'Child' });
    const b = assertDefined(await createTask(listId, { title: 'B' }));

    await moveTasksToListBatch([a.id, parent.id, b.id], followUpListId);

    expect((await db.tasks.get(a.id))?.order).toBe(1);
    expect((await db.tasks.get(b.id))?.order).toBe(2);
  });

  it('turns resolved follow-ups into done tasks on the way back', async () => {
    const fu = assertDefined(await createTask(followUpListId, { title: 'Resolved' }));
    await updateTask(fu.id, { archived: true });

    expect(await moveTasksToListBatch([fu.id], listId)).toEqual({ moved: 1, skipped: 0 });

    const moved = assertDefined(await db.tasks.get(fu.id));
    expect(moved.status).toBe('done');
    expect(moved.archived).toBeFalsy();
  });

  it('leaves state alone between task lists, even for tasks with subtasks', async () => {
    const other = await createTaskList('Other');
    const task = assertDefined(await createTask(listId, { title: 'Blocked parent' }));
    await setTaskStatus(task.id, 'blocked');
    await createSubtask(task.id, { title: 'Child' });

    expect(await moveTasksToListBatch([task.id], other.id)).toEqual({ moved: 1, skipped: 0 });

    const moved = assertDefined(await db.tasks.get(task.id));
    expect(moved.listId).toBe(other.id);
    expect(moved.status).toBe('blocked');
  });

  it('records the translated state in the change log', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Blocked' }));
    await setTaskStatus(task.id, 'blocked');

    await moveTasksToListBatch([task.id], followUpListId);

    const entries = await db.changeLog.orderBy('timestamp').toArray();
    const last = entries.filter((e) => e.entityId === task.id).at(-1);
    expect(last?.data?.listId).toBe(followUpListId);
    expect(last?.data?.status).toBe('todo');
  });

  it('moves nothing into a missing list', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Stay' }));
    expect(await moveTasksToListBatch([task.id], 'no-such-list')).toEqual({ moved: 0, skipped: 0 });
    expect((await db.tasks.get(task.id))?.listId).toBe(listId);
  });
});
