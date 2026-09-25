import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList, deleteTaskList, updateTaskList, restoreTaskList, reorderTaskLists, moveListOrder } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';
import { seedListWithEarlierDeletes, loggedIds } from '../helpers/cascade-fixtures';
import { applyRemoteEntries } from '../../sync/change-log';

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
    const task = assertDefined(await createTask(list.id, { title: 'Task' }));
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
    const task = assertDefined(await createTask(list.id, { title: 'Task' }));
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

describe('list delete / restore vs. children deleted earlier', () => {
  it('deleteTaskList keeps the deletedAt of children deleted before and logs no delete for them', async () => {
    const s = await seedListWithEarlierDeletes();
    await db.changeLog.clear();

    await deleteTaskList(s.list.id);

    const listDeletedAt = assertDefined((await db.taskLists.get(s.list.id))?.deletedAt);
    expect((await db.tasks.get(s.keep.id))?.deletedAt).toBe(listDeletedAt);
    expect((await db.subtasks.get(s.keepSub.id))?.deletedAt).toBe(listDeletedAt);
    expect((await db.tasks.get(s.gone.id))?.deletedAt).toBe(s.earlier.gone);
    expect((await db.subtasks.get(s.goneChild.id))?.deletedAt).toBe(s.earlier.goneChild);
    expect((await db.subtasks.get(s.goneSub.id))?.deletedAt).toBe(s.earlier.goneSub);
    expect(await loggedIds('delete')).toEqual([s.list.id, s.keep.id, s.keepSub.id].sort());
  });

  it('restoreTaskList (undo) brings back only what the list delete took', async () => {
    const s = await seedListWithEarlierDeletes();
    await deleteTaskList(s.list.id);
    await db.changeLog.clear();

    await restoreTaskList(s.list.id);

    expect((await db.taskLists.get(s.list.id))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get(s.keep.id))?.deletedAt).toBeUndefined();
    expect((await db.subtasks.get(s.keepSub.id))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get(s.gone.id))?.deletedAt).toBe(s.earlier.gone);
    expect((await db.subtasks.get(s.goneChild.id))?.deletedAt).toBe(s.earlier.goneChild);
    expect((await db.subtasks.get(s.goneSub.id))?.deletedAt).toBe(s.earlier.goneSub);
    // Upserts for exactly the rows that came back, so other devices converge.
    expect(await loggedIds('upsert')).toEqual([s.list.id, s.keep.id, s.keepSub.id].sort());
  });

  it('converges across devices: B restores what A deleted, A applies B\'s restore', async () => {
    const s = await seedListWithEarlierDeletes();
    await deleteTaskList(s.list.id);
    const aEntries = await db.changeLog.toArray();
    const aRows = {
      lists: await db.taskLists.toArray(),
      tasks: await db.tasks.toArray(),
      subtasks: await db.subtasks.toArray(),
    };
    async function expectRestoredSet() {
      expect((await db.taskLists.get(s.list.id))?.deletedAt).toBeUndefined();
      expect((await db.tasks.get(s.keep.id))?.deletedAt).toBeUndefined();
      expect((await db.subtasks.get(s.keepSub.id))?.deletedAt).toBeUndefined();
      expect((await db.tasks.get(s.gone.id))?.deletedAt).toBeTruthy();
      expect((await db.subtasks.get(s.goneChild.id))?.deletedAt).toBeTruthy();
      expect((await db.subtasks.get(s.goneSub.id))?.deletedAt).toBeTruthy();
    }

    // Device B pulls A's entries (deletes stamp deletedAt with the entry
    // timestamp) and restores the list from its Trash.
    await resetDb();
    await applyRemoteEntries(aEntries);
    await restoreTaskList(s.list.id);
    await expectRestoredSet();
    const bEntries = await db.changeLog.toArray();

    // Device A pulls B's restore.
    await resetDb();
    await db.taskLists.bulkPut(aRows.lists);
    await db.tasks.bulkPut(aRows.tasks);
    await db.subtasks.bulkPut(aRows.subtasks);
    await applyRemoteEntries(bEntries);
    await expectRestoredSet();
  });

  it('restoreTaskList on a list that is not deleted changes nothing', async () => {
    const s = await seedListWithEarlierDeletes();
    await db.changeLog.clear();

    await restoreTaskList(s.list.id);

    expect((await db.tasks.get(s.gone.id))?.deletedAt).toBe(s.earlier.gone);
    expect(await db.changeLog.count()).toBe(0);
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

describe('moveListOrder', () => {
  it('moves a list up before the target and down after it', () => {
    expect(moveListOrder(['a', 'b', 'c', 'd'], 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
    expect(moveListOrder(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('returns null for a no-op or an unknown id', () => {
    expect(moveListOrder(['a', 'b'], 'a', 'a')).toBeNull();
    expect(moveListOrder(['a', 'b'], 'a', 'list-drop-b')).toBeNull();
  });

  // A sidebar search hides lists. Reordering only the visible subset used to
  // renumber it from 0, colliding with the hidden lists' order values.
  it('keeps hidden lists in place and every order value distinct (search filter active)', async () => {
    const a = await createTaskList('Alpha');
    const b = await createTaskList('Beta');
    const c = await createTaskList('Charlie');
    const d = await createTaskList('Delta');
    const all = (await db.taskLists.orderBy('order').toArray()).map((l) => l.id);
    // Visible under a search: Alpha and Delta. Drag Delta onto Alpha.
    await reorderTaskLists(assertDefined(moveListOrder(all, d.id, a.id) ?? undefined));

    const after = await db.taskLists.orderBy('order').toArray();
    expect(after.map((l) => l.id)).toEqual([d.id, a.id, b.id, c.id]);
    expect(new Set(after.map((l) => l.order)).size).toBe(after.length);
  });
});

describe('updateTaskList', () => {
  it('updates name and updatedAt', async () => {
    const list = await createTaskList('Original');
    const before = list.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    await updateTaskList(list.id, { name: 'Renamed' });
    const updated = await db.taskLists.get(list.id);
    expect(updated?.name).toBe('Renamed');
    expect(updated!.updatedAt).toBeGreaterThan(before);
  });
});

describe('error handling', () => {
  it('createTaskList handles db errors gracefully', async () => {
    // Close db to force an error
    db.close();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createTaskList('Fail');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    // Re-open for cleanup
    await db.open();
  });

  it('deleteTaskList handles db errors gracefully', async () => {
    db.close();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await deleteTaskList('nonexistent');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    await db.open();
  });
});
