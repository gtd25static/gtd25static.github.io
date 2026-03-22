import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';
import { permanentlyDelete, restoreFromTrash } from '../../hooks/use-trash';
import type { TrashItem } from '../../hooks/use-trash';

beforeEach(async () => {
  await resetDb();
});

describe('permanentlyDelete', () => {
  it('hard-deletes a list', async () => {
    const list = await createTaskList('Delete Me');
    const item: TrashItem = { id: list.id, type: 'list', title: list.name, deletedAt: Date.now() };
    await permanentlyDelete(item);
    const result = await db.taskLists.get(list.id);
    expect(result).toBeUndefined();
  });

  it('hard-deletes a list and cascades to its tasks and subtasks', async () => {
    const list = await createTaskList('Delete Me');
    const task = assertDefined(await createTask(list.id, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    const item: TrashItem = { id: list.id, type: 'list', title: list.name, deletedAt: Date.now() };
    await permanentlyDelete(item);
    expect(await db.taskLists.get(list.id)).toBeUndefined();
    expect(await db.tasks.get(task.id)).toBeUndefined();
    expect(await db.subtasks.get(sub.id)).toBeUndefined();
  });

  it('hard-deletes a task and its subtasks', async () => {
    const list = await createTaskList('List');
    const task = assertDefined(await createTask(list.id, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    const item: TrashItem = { id: task.id, type: 'task', title: task.title, deletedAt: Date.now() };
    await permanentlyDelete(item);
    expect(await db.tasks.get(task.id)).toBeUndefined();
    expect(await db.subtasks.get(sub.id)).toBeUndefined();
  });

  it('hard-deletes a subtask', async () => {
    const list = await createTaskList('List');
    const task = assertDefined(await createTask(list.id, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    const item: TrashItem = { id: sub.id, type: 'subtask', title: sub.title, deletedAt: Date.now() };
    await permanentlyDelete(item);
    expect(await db.subtasks.get(sub.id)).toBeUndefined();
  });
});

describe('restoreFromTrash', () => {
  it('restores a list with cascading restore', async () => {
    const list = await createTaskList('List');
    const task = assertDefined(await createTask(list.id, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));

    const now = Date.now();
    await db.taskLists.update(list.id, { deletedAt: now });
    await db.tasks.update(task.id, { deletedAt: now });
    await db.subtasks.update(sub.id, { deletedAt: now });

    const item: TrashItem = { id: list.id, type: 'list', title: list.name, deletedAt: now };
    await restoreFromTrash(item);

    expect((await db.taskLists.get(list.id))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get(task.id))?.deletedAt).toBeUndefined();
    expect((await db.subtasks.get(sub.id))?.deletedAt).toBeUndefined();
  });

  it('restores a task with cascading restore', async () => {
    const list = await createTaskList('List');
    const task = assertDefined(await createTask(list.id, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));

    const now = Date.now();
    await db.tasks.update(task.id, { deletedAt: now });
    await db.subtasks.update(sub.id, { deletedAt: now });

    const item: TrashItem = { id: task.id, type: 'task', title: task.title, deletedAt: now };
    await restoreFromTrash(item);

    expect((await db.tasks.get(task.id))?.deletedAt).toBeUndefined();
    expect((await db.subtasks.get(sub.id))?.deletedAt).toBeUndefined();
  });

  it('restores a subtask and marks pending', async () => {
    const list = await createTaskList('List');
    const task = assertDefined(await createTask(list.id, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));

    const now = Date.now();
    await db.subtasks.update(sub.id, { deletedAt: now });
    // Reset pending to verify it gets set
    await db.syncMeta.update('sync-meta', { pendingChanges: false });

    const item: TrashItem = { id: sub.id, type: 'subtask', title: sub.title, deletedAt: now };
    await restoreFromTrash(item);

    expect((await db.subtasks.get(sub.id))?.deletedAt).toBeUndefined();
    const entries = await db.changeLog.toArray();
    expect(entries.some((e) => e.entityType === 'subtask' && e.operation === 'upsert')).toBe(true);
  });
});

describe('error handling', () => {
  it('permanentlyDelete handles db errors gracefully', async () => {
    db.close();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const item: TrashItem = { id: 'nonexistent', type: 'task', title: 'X', deletedAt: Date.now() };
    await permanentlyDelete(item);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    await db.open();
  });

  it('restoreFromTrash handles db errors gracefully', async () => {
    db.close();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const item: TrashItem = { id: 'nonexistent', type: 'subtask', title: 'X', deletedAt: Date.now() };
    await restoreFromTrash(item);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    await db.open();
  });
});
