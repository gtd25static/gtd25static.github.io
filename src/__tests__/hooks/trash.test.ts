import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList, deleteTaskList } from '../../hooks/use-task-lists';
import { createTask, deleteTask } from '../../hooks/use-tasks';
import { createSubtask, deleteSubtask } from '../../hooks/use-subtasks';
import { permanentlyDelete, restoreFromTrash } from '../../hooks/use-trash';
import type { TrashItem } from '../../hooks/use-trash';
import { seedListWithEarlierDeletes, loggedIds } from '../helpers/cascade-fixtures';

beforeEach(async () => {
  await resetDb();
});

describe('permanentlyDelete', () => {
  it('hard-deletes a list', async () => {
    const list = await createTaskList('Delete Me');
    await deleteTaskList(list.id);
    const item: TrashItem = { id: list.id, type: 'list', title: list.name, deletedAt: Date.now() };
    await permanentlyDelete(item);
    const result = await db.taskLists.get(list.id);
    expect(result).toBeUndefined();
  });

  it('hard-deletes a list and cascades to its tasks and subtasks', async () => {
    const list = await createTaskList('Delete Me');
    const task = assertDefined(await createTask(list.id, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    await deleteTaskList(list.id);
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
    await deleteTask(task.id);
    const item: TrashItem = { id: task.id, type: 'task', title: task.title, deletedAt: Date.now() };
    await permanentlyDelete(item);
    expect(await db.tasks.get(task.id)).toBeUndefined();
    expect(await db.subtasks.get(sub.id)).toBeUndefined();
  });

  it('hard-deletes a subtask', async () => {
    const list = await createTaskList('List');
    const task = assertDefined(await createTask(list.id, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    await deleteSubtask(sub.id);
    const item: TrashItem = { id: sub.id, type: 'subtask', title: sub.title, deletedAt: Date.now() };
    await permanentlyDelete(item);
    expect(await db.subtasks.get(sub.id)).toBeUndefined();
  });

  it('hard-deletes the tombstones under a list but never a live task or subtask', async () => {
    const s = await seedListWithEarlierDeletes();
    await deleteTaskList(s.list.id);
    // A task live inside the deleted list (restored by an older version, or
    // synced in): the list's permanent delete must not destroy it.
    const survivor = assertDefined(await db.tasks.get(s.keep.id));
    await db.tasks.update(survivor.id, { deletedAt: undefined });
    await db.subtasks.update(s.keepSub.id, { deletedAt: undefined });
    await db.changeLog.clear();

    await permanentlyDelete({ id: s.list.id, type: 'list', title: s.list.name, deletedAt: Date.now() });

    expect(await db.taskLists.get(s.list.id)).toBeUndefined();
    expect(await db.tasks.get(s.gone.id)).toBeUndefined();
    expect(await db.subtasks.get(s.goneChild.id)).toBeUndefined();
    expect(await db.tasks.get(s.keep.id)).toBeDefined();
    expect(await db.subtasks.get(s.keepSub.id)).toBeDefined();
    // goneSub is a tombstone of the live task, not of the list: left to the task.
    expect(await db.subtasks.get(s.goneSub.id)).toBeDefined();
    expect(await loggedIds('delete')).toEqual([s.list.id, s.gone.id, s.goneChild.id].sort());
  });

  it('hard-deletes a task\'s deleted subtasks but never a live one', async () => {
    const s = await seedListWithEarlierDeletes();
    await deleteTask(s.keep.id);
    await db.subtasks.update(s.keepSub.id, { deletedAt: undefined });
    await db.changeLog.clear();

    await permanentlyDelete({ id: s.keep.id, type: 'task', title: s.keep.title, deletedAt: Date.now() });

    expect(await db.tasks.get(s.keep.id)).toBeUndefined();
    expect(await db.subtasks.get(s.goneSub.id)).toBeUndefined();
    expect(await db.subtasks.get(s.keepSub.id)).toBeDefined();
    expect(await loggedIds('delete')).toEqual([s.keep.id, s.goneSub.id].sort());
  });

  it('does nothing when the item was restored meanwhile (stale Trash row)', async () => {
    const s = await seedListWithEarlierDeletes();
    await db.changeLog.clear();

    await permanentlyDelete({ id: s.list.id, type: 'list', title: s.list.name, deletedAt: Date.now() });
    await permanentlyDelete({ id: s.keep.id, type: 'task', title: s.keep.title, deletedAt: Date.now() });
    await permanentlyDelete({ id: s.keepSub.id, type: 'subtask', title: s.keepSub.title, deletedAt: Date.now() });

    expect(await db.taskLists.get(s.list.id)).toBeDefined();
    expect(await db.tasks.get(s.keep.id)).toBeDefined();
    expect(await db.subtasks.get(s.keepSub.id)).toBeDefined();
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('restoring a child whose parent is deleted', () => {
  it('a task restored from a deleted list brings the list back, but none of its other tasks', async () => {
    const s = await seedListWithEarlierDeletes();
    const other = assertDefined(await createTask(s.list.id, { title: 'Other' }));
    await deleteTaskList(s.list.id);
    await db.changeLog.clear();

    await restoreFromTrash({ id: s.keep.id, type: 'task', title: s.keep.title, deletedAt: Date.now() });

    expect((await db.taskLists.get(s.list.id))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get(s.keep.id))?.deletedAt).toBeUndefined();
    expect((await db.subtasks.get(s.keepSub.id))?.deletedAt).toBeUndefined(); // taken by the same delete
    expect((await db.tasks.get(other.id))?.deletedAt).toBeTruthy();
    expect((await db.tasks.get(s.gone.id))?.deletedAt).toBe(s.earlier.gone);
    expect((await db.subtasks.get(s.goneSub.id))?.deletedAt).toBe(s.earlier.goneSub);
    expect(await loggedIds('upsert')).toEqual([s.list.id, s.keep.id, s.keepSub.id].sort());
  });

  it('a subtask restored from a deleted task in a deleted list brings back just those two rows', async () => {
    const s = await seedListWithEarlierDeletes();
    const sibling = assertDefined(await createSubtask(s.keep.id, { title: 'Sibling' }));
    const other = assertDefined(await createTask(s.list.id, { title: 'Other' }));
    await deleteTaskList(s.list.id);
    await db.changeLog.clear();

    await restoreFromTrash({ id: s.keepSub.id, type: 'subtask', title: s.keepSub.title, deletedAt: Date.now() });

    expect((await db.subtasks.get(s.keepSub.id))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get(s.keep.id))?.deletedAt).toBeUndefined();
    expect((await db.taskLists.get(s.list.id))?.deletedAt).toBeUndefined();
    expect((await db.subtasks.get(sibling.id))?.deletedAt).toBeTruthy();
    expect((await db.tasks.get(other.id))?.deletedAt).toBeTruthy();
    expect(await loggedIds('upsert')).toEqual([s.list.id, s.keep.id, s.keepSub.id].sort());
  });

  it('a subtask restored from a deleted task in a live list leaves the list alone', async () => {
    const s = await seedListWithEarlierDeletes();
    await deleteTask(s.keep.id);
    await db.changeLog.clear();

    await restoreFromTrash({ id: s.keepSub.id, type: 'subtask', title: s.keepSub.title, deletedAt: Date.now() });

    expect((await db.tasks.get(s.keep.id))?.deletedAt).toBeUndefined();
    expect(await loggedIds('upsert')).toEqual([s.keep.id, s.keepSub.id].sort());
  });

  it('an archived list that expired while in the Trash comes back with a fresh archive date', async () => {
    const s = await seedListWithEarlierDeletes();
    await db.taskLists.update(s.list.id, { archivedAt: 1 });
    await deleteTaskList(s.list.id);

    await restoreFromTrash({ id: s.keep.id, type: 'task', title: s.keep.title, deletedAt: Date.now() });

    const list = assertDefined(await db.taskLists.get(s.list.id));
    expect(list.deletedAt).toBeUndefined();
    expect(list.archivedAt).toBeGreaterThan(1);
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

  it('restoring a list brings back only what the list delete took', async () => {
    const s = await seedListWithEarlierDeletes();
    await deleteTaskList(s.list.id);
    const deletedAt = assertDefined((await db.taskLists.get(s.list.id))?.deletedAt);
    await db.changeLog.clear();

    await restoreFromTrash({ id: s.list.id, type: 'list', title: s.list.name, deletedAt });

    expect((await db.taskLists.get(s.list.id))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get(s.keep.id))?.deletedAt).toBeUndefined();
    expect((await db.subtasks.get(s.keepSub.id))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get(s.gone.id))?.deletedAt).toBe(s.earlier.gone);
    expect((await db.subtasks.get(s.goneChild.id))?.deletedAt).toBe(s.earlier.goneChild);
    expect((await db.subtasks.get(s.goneSub.id))?.deletedAt).toBe(s.earlier.goneSub);
    expect(await loggedIds('upsert')).toEqual([s.list.id, s.keep.id, s.keepSub.id].sort());
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

  it('restoring a task brings back only the subtasks its delete took', async () => {
    const s = await seedListWithEarlierDeletes(); // keep has keepSub (live) and goneSub (deleted earlier)
    await deleteTask(s.keep.id);
    const deletedAt = assertDefined((await db.tasks.get(s.keep.id))?.deletedAt);
    await db.changeLog.clear();

    await restoreFromTrash({ id: s.keep.id, type: 'task', title: s.keep.title, deletedAt });

    expect((await db.tasks.get(s.keep.id))?.deletedAt).toBeUndefined();
    expect((await db.subtasks.get(s.keepSub.id))?.deletedAt).toBeUndefined();
    expect((await db.subtasks.get(s.goneSub.id))?.deletedAt).toBe(s.earlier.goneSub);
    expect(await loggedIds('upsert')).toEqual([s.keep.id, s.keepSub.id].sort());
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
