import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, updateTask, setTaskStatus, deleteTask, restoreTask, moveTaskToList, reorderTasks } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';

let listId: string;

beforeEach(async () => {
  await resetDb();
  const list = await createTaskList('Test List');
  listId = list.id;
});

describe('createTask', () => {
  it('creates a task with correct fields', async () => {
    const task = assertDefined(await createTask(listId, { title: 'My Task', description: 'Desc', link: 'https://x.com' }));
    expect(task.title).toBe('My Task');
    expect(task.description).toBe('Desc');
    expect(task.link).toBe('https://x.com');
    expect(task.status).toBe('todo');
    expect(task.listId).toBe(listId);
    expect(task.deletedAt).toBeUndefined();
  });

  it('auto-increments order within list', async () => {
    const t1 = assertDefined(await createTask(listId, { title: 'First' }));
    const t2 = assertDefined(await createTask(listId, { title: 'Second' }));
    expect(t1.order).toBe(0);
    expect(t2.order).toBe(1);
  });

  it('records change in changelog', async () => {
    await createTask(listId, { title: 'Test' });
    const entries = await db.changeLog.toArray();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.entityType === 'task' && e.operation === 'upsert')).toBe(true);
  });
});

describe('updateTask', () => {
  it('updates fields and updatedAt', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Original' }));
    const before = task.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    await updateTask(task.id, { title: 'Updated' });
    const updated = await db.tasks.get(task.id);
    expect(updated?.title).toBe('Updated');
    expect(updated!.updatedAt).toBeGreaterThan(before);
  });

  it('preserves unspecified fields', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Keep', description: 'Keep this' }));
    await updateTask(task.id, { title: 'Changed' });
    const updated = await db.tasks.get(task.id);
    expect(updated?.description).toBe('Keep this');
  });
});

describe('setTaskStatus', () => {
  it('changes status', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Test' }));
    await setTaskStatus(task.id, 'done');
    const updated = await db.tasks.get(task.id);
    expect(updated?.status).toBe('done');
  });
});

describe('deleteTask', () => {
  it('soft-deletes task and cascades to subtasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Doomed' }));
    await createSubtask(task.id, { title: 'Sub' });
    await deleteTask(task.id);
    const deleted = await db.tasks.get(task.id);
    expect(deleted?.deletedAt).toBeDefined();
    const subs = await db.subtasks.where('taskId').equals(task.id).toArray();
    expect(subs[0].deletedAt).toBeDefined();
  });
});

describe('restoreTask', () => {
  it('restores task and cascades to subtasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Restore' }));
    await createSubtask(task.id, { title: 'Sub' });
    await deleteTask(task.id);
    await restoreTask(task.id);
    const restored = await db.tasks.get(task.id);
    expect(restored?.deletedAt).toBeUndefined();
    const subs = await db.subtasks.where('taskId').equals(task.id).toArray();
    expect(subs[0].deletedAt).toBeUndefined();
  });
});

describe('moveTaskToList', () => {
  it('changes listId and appends to end', async () => {
    const list2 = await createTaskList('Other List');
    await createTask(list2.id, { title: 'Existing' });
    const task = assertDefined(await createTask(listId, { title: 'Moving' }));

    await moveTaskToList(task.id, list2.id);

    const moved = await db.tasks.get(task.id);
    expect(moved?.listId).toBe(list2.id);
    expect(moved?.order).toBe(1); // appended after existing
  });
});

describe('reorderTasks', () => {
  it('assigns sequential order', async () => {
    const a = assertDefined(await createTask(listId, { title: 'A' }));
    const b = assertDefined(await createTask(listId, { title: 'B' }));
    const c = assertDefined(await createTask(listId, { title: 'C' }));

    await reorderTasks([c.id, a.id, b.id]);

    const tasks = await db.tasks.orderBy('order').toArray();
    expect(tasks[0].id).toBe(c.id);
    expect(tasks[1].id).toBe(a.id);
    expect(tasks[2].id).toBe(b.id);
  });
});
