// @vitest-environment jsdom
import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { resetAppState } from '../helpers/component-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { createSubtask, setSubtaskStatus } from '../../hooks/use-subtasks';
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
  it('starts and reveals a task with no undone subtasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));

    await focusTask(task.id, { startTimer: false });

    const updated = await db.tasks.get(task.id);
    expect(updated?.status).toBe('working');
    expect(useAppState.getState().selectedListId).toBe(listId);
    expect(useAppState.getState().expandedTaskIds.has(task.id)).toBe(true);
    expect(useAppState.getState().navigateToTaskId).toBe(task.id);
  });

  it('starts the first undone subtask and reveals the parent task', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const done = assertDefined(await createSubtask(task.id, { title: 'Done first' }));
    const next = assertDefined(await createSubtask(task.id, { title: 'Next up' }));
    await setSubtaskStatus(done.id, 'done');

    await focusTask(task.id, { startTimer: false });

    expect((await db.subtasks.get(done.id))?.status).toBe('done');
    expect((await db.subtasks.get(next.id))?.status).toBe('working');
    expect(useAppState.getState().selectedListId).toBe(listId);
    expect(useAppState.getState().expandedTaskIds.has(task.id)).toBe(true);
    expect(useAppState.getState().navigateToTaskId).toBe(task.id);
  });

  it('reveals but does not start a task whose remaining subtasks are blocked', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const blocked = assertDefined(await createSubtask(task.id, { title: 'Blocked' }));
    await setSubtaskStatus(blocked.id, 'blocked');

    await focusTask(task.id, { startTimer: false });

    expect((await db.tasks.get(task.id))?.status).toBe('todo');
    expect((await db.subtasks.get(blocked.id))?.status).toBe('blocked');
    expect(useAppState.getState().selectedListId).toBe(listId);
    expect(useAppState.getState().navigateToTaskId).toBe(task.id);
  });

  it('starts a specific todo subtask when requested', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const first = assertDefined(await createSubtask(task.id, { title: 'First' }));
    const second = assertDefined(await createSubtask(task.id, { title: 'Second' }));

    await focusTask(task.id, { startTimer: false, subtaskId: second.id });

    expect((await db.subtasks.get(first.id))?.status).toBe('todo');
    expect((await db.subtasks.get(second.id))?.status).toBe('working');
  });
});
