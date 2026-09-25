import { db, cleanOrphans } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';
import { newId } from '../../lib/id';

beforeEach(async () => {
  await resetDb();
});

describe('cleanOrphans', () => {
  it('soft-deletes subtasks whose parent task does not exist', async () => {
    const orphanSubId = newId();
    await db.subtasks.add({
      id: orphanSubId,
      taskId: 'nonexistent-task',
      title: 'Orphan Sub',
      status: 'todo',
      order: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cleanOrphans();
    warnSpy.mockRestore();

    const sub = await db.subtasks.get(orphanSubId);
    expect(sub?.deletedAt).toBeDefined();
  });

  it('moves orphaned tasks to Inbox when Inbox exists', async () => {
    const inbox = await createTaskList('Inbox');
    const orphanTaskId = newId();
    await db.tasks.add({
      id: orphanTaskId,
      listId: 'nonexistent-list',
      title: 'Orphan Task',
      status: 'todo',
      order: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cleanOrphans();
    warnSpy.mockRestore();

    const task = await db.tasks.get(orphanTaskId);
    expect(task?.listId).toBe(inbox.id);
    expect(task?.deletedAt).toBeUndefined();
  });

  it('creates an Inbox for orphaned tasks when none exists, instead of trashing them', async () => {
    // Trashing them looped: restoring one left it pointing at the missing list,
    // and the next startup trashed it again.
    const orphanTaskId = newId();
    await db.tasks.add({
      id: orphanTaskId,
      listId: 'nonexistent-list',
      title: 'Orphan Task',
      status: 'todo',
      order: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cleanOrphans();
    warnSpy.mockRestore();

    const task = await db.tasks.get(orphanTaskId);
    expect(task?.deletedAt).toBeUndefined();
    const inbox = (await db.taskLists.toArray()).find((l) => l.name === 'Inbox');
    expect(inbox).toBeDefined();
    expect(task?.listId).toBe(inbox!.id);
    // …and the new Inbox syncs like any list.
    expect((await db.changeLog.toArray()).some((e) => e.entityType === 'taskList' && e.entityId === inbox!.id)).toBe(true);
  });

  it('does nothing when there are no orphans', async () => {
    const list = await createTaskList('Normal');
    const task = await createTask(list.id, { title: 'Normal Task' });
    if (task) await createSubtask(task.id, { title: 'Normal Sub' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cleanOrphans();
    // No warnings expected
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('skips already-deleted orphans', async () => {
    const orphanSubId = newId();
    await db.subtasks.add({
      id: orphanSubId,
      taskId: 'nonexistent-task',
      title: 'Already Deleted Orphan',
      status: 'todo',
      order: 0,
      deletedAt: 12345,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cleanOrphans();
    // Should not count already-deleted as orphan
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();

    const sub = await db.subtasks.get(orphanSubId);
    expect(sub?.deletedAt).toBe(12345); // Unchanged
  });

  it('records changelog entries for orphaned subtasks', async () => {
    const orphanSubId = newId();
    await db.subtasks.add({
      id: orphanSubId,
      taskId: 'nonexistent-task',
      title: 'Orphan Sub',
      status: 'todo',
      order: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const beforeCount = await db.changeLog.count();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cleanOrphans();
    warnSpy.mockRestore();

    const afterCount = await db.changeLog.count();
    expect(afterCount).toBeGreaterThan(beforeCount);
    const entries = await db.changeLog.toArray();
    const orphanEntry = entries.find((e) => e.entityId === orphanSubId);
    expect(orphanEntry).toBeDefined();
    expect(orphanEntry!.entityType).toBe('subtask');
    expect(orphanEntry!.operation).toBe('upsert');
  });

  it('stamps fieldTimestamps when soft-deleting orphaned subtasks', async () => {
    const orphanSubId = newId();
    await db.subtasks.add({
      id: orphanSubId,
      taskId: 'nonexistent-task',
      title: 'Orphan Sub',
      status: 'todo',
      order: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cleanOrphans();
    warnSpy.mockRestore();

    const sub = await db.subtasks.get(orphanSubId);
    expect(sub?.fieldTimestamps).toBeDefined();
    expect(sub?.fieldTimestamps?.deletedAt).toBeDefined();
    expect(sub!.fieldTimestamps!.deletedAt).toBeGreaterThan(0);
  });

  it('records changelog entries for orphaned tasks', async () => {
    const orphanTaskId = newId();
    await db.tasks.add({
      id: orphanTaskId,
      listId: 'nonexistent-list',
      title: 'Orphan Task',
      status: 'todo',
      order: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cleanOrphans();
    warnSpy.mockRestore();

    const entries = await db.changeLog.toArray();
    const orphanEntry = entries.find((e) => e.entityId === orphanTaskId);
    expect(orphanEntry).toBeDefined();
    expect(orphanEntry!.entityType).toBe('task');
    expect(orphanEntry!.operation).toBe('upsert');
  });
});

describe('cleanOrphans — live children of a deleted parent', () => {
  // Another device deleted the list while this one added a task to it: the task
  // stayed alive inside a list in the Trash, invisible until the list was
  // restored (GUI review). It now joins the list's cascade (same deletedAt), so
  // restoring the list brings it back and deleting it forever removes it.
  it('moves a live task of a deleted list into the list\'s cascade', async () => {
    const list = await createTaskList('Deleted elsewhere');
    await db.taskLists.update(list.id, { deletedAt: 5_000 });
    const task = await createTask(list.id, { title: 'Added meanwhile' });
    const sub = await createSubtask(task!.id, { title: 'Its step' });

    await cleanOrphans();

    expect((await db.tasks.get(task!.id))?.deletedAt).toBe(5_000);
    expect((await db.subtasks.get(sub!.id))?.deletedAt).toBe(5_000);
    const logged = (await db.changeLog.toArray()).map((e) => e.entityId);
    expect(logged).toEqual(expect.arrayContaining([task!.id, sub!.id]));
  });

  it('moves a live subtask of a deleted task into the task\'s cascade', async () => {
    const list = await createTaskList('Live list');
    const task = await createTask(list.id, { title: 'Deleted elsewhere' });
    await db.tasks.update(task!.id, { deletedAt: 7_000 });
    const sub = await createSubtask(task!.id, { title: 'Added meanwhile' });

    await cleanOrphans();

    expect((await db.subtasks.get(sub!.id))?.deletedAt).toBe(7_000);
  });
});
