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

  it('soft-deletes orphaned tasks when no Inbox exists', async () => {
    // Create a non-Inbox list, then add an orphaned task referencing a deleted list
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
    expect(task?.deletedAt).toBeDefined();
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
});
