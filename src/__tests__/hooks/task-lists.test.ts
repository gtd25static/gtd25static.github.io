import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { createTaskList, deleteTaskList, restoreTaskList, reorderTaskLists } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';

beforeEach(async () => {
  await resetDb();
});

describe('createTaskList', () => {
  it('creates a list with correct defaults', async () => {
    const list = await createTaskList('My List');
    expect(list.name).toBe('My List');
    expect(list.type).toBe('tasks');
    expect(list.order).toBe(0);
    expect(list.createdAt).toBeGreaterThan(0);
    expect(list.updatedAt).toBe(list.createdAt);
    expect(list.deletedAt).toBeUndefined();
  });

  it('auto-increments order', async () => {
    const list1 = await createTaskList('First');
    const list2 = await createTaskList('Second');
    expect(list1.order).toBe(0);
    expect(list2.order).toBe(1);
  });

  it('records change in changelog', async () => {
    await createTaskList('Test');
    const entries = await db.changeLog.toArray();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].entityType).toBe('taskList');
    expect(entries[0].operation).toBe('upsert');
  });

  it('accepts custom type', async () => {
    const list = await createTaskList('Follow Ups', 'follow-ups');
    expect(list.type).toBe('follow-ups');
  });
});

describe('deleteTaskList', () => {
  it('soft-deletes the list', async () => {
    const list = await createTaskList('Doomed');
    await deleteTaskList(list.id);
    const deleted = await db.taskLists.get(list.id);
    expect(deleted?.deletedAt).toBeDefined();
  });

  it('cascades to tasks and subtasks', async () => {
    const list = await createTaskList('Parent');
    const task = await createTask(list.id, { title: 'Task' });
    await createSubtask(task.id, { title: 'Sub' });

    await deleteTaskList(list.id);

    const tasks = await db.tasks.where('listId').equals(list.id).toArray();
    const subtasks = await db.subtasks.where('taskId').equals(task.id).toArray();
    expect(tasks[0].deletedAt).toBeDefined();
    expect(subtasks[0].deletedAt).toBeDefined();
  });
});

describe('restoreTaskList', () => {
  it('restores list and cascades to children', async () => {
    const list = await createTaskList('Restore Me');
    const task = await createTask(list.id, { title: 'Task' });
    await createSubtask(task.id, { title: 'Sub' });
    await deleteTaskList(list.id);

    await restoreTaskList(list.id);

    const restored = await db.taskLists.get(list.id);
    expect(restored?.deletedAt).toBeUndefined();
    const tasks = await db.tasks.where('listId').equals(list.id).toArray();
    expect(tasks[0].deletedAt).toBeUndefined();
    const subtasks = await db.subtasks.where('taskId').equals(task.id).toArray();
    expect(subtasks[0].deletedAt).toBeUndefined();
  });
});

describe('reorderTaskLists', () => {
  it('assigns sequential order', async () => {
    const a = await createTaskList('A');
    const b = await createTaskList('B');
    const c = await createTaskList('C');

    await reorderTaskLists([c.id, a.id, b.id]);

    const lists = await db.taskLists.orderBy('order').toArray();
    expect(lists[0].id).toBe(c.id);
    expect(lists[1].id).toBe(a.id);
    expect(lists[2].id).toBe(b.id);
    expect(lists[0].order).toBe(0);
    expect(lists[1].order).toBe(1);
    expect(lists[2].order).toBe(2);
  });
});
