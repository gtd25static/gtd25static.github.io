import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
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
