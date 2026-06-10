// @vitest-environment jsdom
import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { resetAppState } from '../helpers/component-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, updateTask, setTaskStatus } from '../../hooks/use-tasks';
import { focusTask } from '../../hooks/use-focus';
import { useAppState } from '../../stores/app-state';

let listId: string;

beforeEach(async () => {
  await resetDb();
  resetAppState();
  const list = await createTaskList('List');
  listId = list.id;
});

describe('focusTask', () => {
  it('stamps workedAt (with a change-log entry) and reveals the task — no status change', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const changesBefore = await db.changeLog.count();

    await focusTask(task.id, { startTimer: false });

    const updated = assertDefined(await db.tasks.get(task.id));
    expect(updated.status).toBe('todo');
    expect(updated.workedAt).toBeDefined();
    expect(updated.fieldTimestamps?.workedAt).toBe(updated.updatedAt);
    expect(await db.changeLog.count()).toBe(changesBefore + 1);
    expect(useAppState.getState().selectedListId).toBe(listId);
    expect(useAppState.getState().expandedTaskIds.has(task.id)).toBe(true);
    expect(useAppState.getState().navigateToTaskId).toBe(task.id);
  });

  it('leaves an existing workedAt untouched', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const earlier = Date.now() - 1000;
    await updateTask(task.id, { workedAt: earlier });

    await focusTask(task.id);

    expect((await db.tasks.get(task.id))?.workedAt).toBe(earlier);
  });

  it('does not navigate with navigate: false', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));

    await focusTask(task.id, { navigate: false });

    expect(useAppState.getState().selectedListId).not.toBe(listId);
    expect(useAppState.getState().navigateToTaskId).toBeNull();
    expect((await db.tasks.get(task.id))?.workedAt).toBeDefined();
  });

  it('no-ops on done, deleted, and archived tasks', async () => {
    const done = assertDefined(await createTask(listId, { title: 'Done' }));
    await setTaskStatus(done.id, 'done');
    const archived = assertDefined(await createTask(listId, { title: 'Archived' }));
    await updateTask(archived.id, { archived: true });

    await focusTask(done.id);
    await focusTask(archived.id);
    await focusTask('no-such-id');

    expect((await db.tasks.get(done.id))?.workedAt).toBeUndefined();
    expect((await db.tasks.get(archived.id))?.workedAt).toBeUndefined();
    expect(useAppState.getState().navigateToTaskId).toBeNull();
  });
});
