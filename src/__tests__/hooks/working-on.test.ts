import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { createSubtask, setSubtaskStatus } from '../../hooks/use-subtasks';
import {
  startWorkingOn, startWorkingOnTask, stopWorking,
  markWorkingDone, markWorkingBlocked, switchTask,
} from '../../hooks/use-working-on';

let listId: string;

beforeEach(async () => {
  await resetDb();
  const list = await createTaskList('List');
  listId = list.id;
});

describe('startWorkingOn', () => {
  it('sets subtask to working', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));

    await startWorkingOn(sub.id);

    const s = await db.subtasks.get(sub.id);
    expect(s?.status).toBe('working');
  });

  it('clears other working subtask', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const sub1 = assertDefined(await createSubtask(task.id, { title: 'Sub 1' }));
    const sub2 = assertDefined(await createSubtask(task.id, { title: 'Sub 2' }));

    await startWorkingOn(sub1.id);
    await startWorkingOn(sub2.id);

    const s1 = await db.subtasks.get(sub1.id);
    const s2 = await db.subtasks.get(sub2.id);
    expect(s1?.status).toBe('todo');
    expect(s2?.status).toBe('working');
  });

  it('sets workedAt on parent task', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));

    await startWorkingOn(sub.id);

    const t = await db.tasks.get(task.id);
    expect(t?.workedAt).toBeDefined();
    expect(typeof t?.workedAt).toBe('number');
  });

  it('clears working task', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    await startWorkingOnTask(task.id);
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));

    await startWorkingOn(sub.id);

    const t = await db.tasks.get(task.id);
    expect(t?.status).toBe('todo');
  });
});

describe('startWorkingOnTask', () => {
  it('sets task to working', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    await startWorkingOnTask(task.id);
    const t = await db.tasks.get(task.id);
    expect(t?.status).toBe('working');
  });

  it('sets workedAt on first work start', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    expect((await db.tasks.get(task.id))?.workedAt).toBeUndefined();

    await startWorkingOnTask(task.id);
    const t = await db.tasks.get(task.id);
    expect(t?.workedAt).toBeDefined();
    expect(typeof t?.workedAt).toBe('number');
  });

  it('does not overwrite workedAt on subsequent starts', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    await startWorkingOnTask(task.id);
    const firstWorkedAt = (await db.tasks.get(task.id))?.workedAt;

    await stopWorking();
    await startWorkingOnTask(task.id);
    const secondWorkedAt = (await db.tasks.get(task.id))?.workedAt;

    expect(secondWorkedAt).toBe(firstWorkedAt);
  });

  it('clears working subtask', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    await startWorkingOn(sub.id);

    const task2 = assertDefined(await createTask(listId, { title: 'Task 2' }));
    await startWorkingOnTask(task2.id);

    const s = await db.subtasks.get(sub.id);
    expect(s?.status).toBe('todo');
  });

  it('clears other working task', async () => {
    const task1 = assertDefined(await createTask(listId, { title: 'Task 1' }));
    const task2 = assertDefined(await createTask(listId, { title: 'Task 2' }));

    await startWorkingOnTask(task1.id);
    await startWorkingOnTask(task2.id);

    const t1 = await db.tasks.get(task1.id);
    const t2 = await db.tasks.get(task2.id);
    expect(t1?.status).toBe('todo');
    expect(t2?.status).toBe('working');
  });
});

describe('stopWorking', () => {
  it('resets all working to todo', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    await startWorkingOn(sub.id);

    await stopWorking();

    const s = await db.subtasks.get(sub.id);
    expect(s?.status).toBe('todo');
    const allWorkingTasks = await db.tasks.where('status').equals('working').toArray();
    const allWorkingSubs = await db.subtasks.where('status').equals('working').toArray();
    expect(allWorkingTasks).toHaveLength(0);
    expect(allWorkingSubs).toHaveLength(0);
  });
});

describe('markWorkingDone', () => {
  it('marks working subtask done and advances to next', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const s1 = assertDefined(await createSubtask(task.id, { title: 'Sub 1' }));
    const s2 = assertDefined(await createSubtask(task.id, { title: 'Sub 2' }));

    await startWorkingOn(s1.id);
    await markWorkingDone();

    const done = await db.subtasks.get(s1.id);
    expect(done?.status).toBe('done');
    const next = await db.subtasks.get(s2.id);
    expect(next?.status).toBe('working');
  });

  it('completes parent when all subtasks done', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const s1 = assertDefined(await createSubtask(task.id, { title: 'Only Sub' }));

    await startWorkingOn(s1.id);
    await markWorkingDone();

    const parent = await db.tasks.get(task.id);
    expect(parent?.status).toBe('done');
  });

  it('is a no-op when nothing working', async () => {
    // Should not throw
    await markWorkingDone();
  });
});

describe('markWorkingBlocked', () => {
  it('marks working subtask blocked', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    await startWorkingOn(sub.id);

    await markWorkingBlocked();

    const s = await db.subtasks.get(sub.id);
    expect(s?.status).toBe('blocked');
  });

  it('sets blockedAt when blocking working subtask', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    await startWorkingOn(sub.id);

    const before = Date.now();
    await markWorkingBlocked();

    const s = await db.subtasks.get(sub.id);
    expect(s?.blockedAt).toBeDefined();
    expect(s!.blockedAt).toBeGreaterThanOrEqual(before);
    expect(s!.blockedAt).toBeLessThanOrEqual(Date.now());
  });

  it('is a no-op when nothing working', async () => {
    await markWorkingBlocked();
  });
});

describe('switchTask', () => {
  it('stops current and finds oldest task with undone subtask', async () => {
    const task1 = assertDefined(await createTask(listId, { title: 'Older' }));
    // Ensure task1 has a definitively earlier createdAt
    await db.tasks.update(task1.id, { createdAt: task1.createdAt - 1000 });
    const s1 = assertDefined(await createSubtask(task1.id, { title: 'Sub 1' }));
    const task2 = assertDefined(await createTask(listId, { title: 'Newer' }));
    await createSubtask(task2.id, { title: 'Sub 2' });

    await startWorkingOn(s1.id);
    const result = await switchTask();

    // After stopping s1, it becomes 'todo' again, so switchTask should pick task1's subtask
    expect(result).not.toBeNull();
    expect(result!.task.id).toBe(task1.id);
  });

  it('returns null when no tasks have undone subtasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Done' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    await setSubtaskStatus(sub.id, 'done');

    const result = await switchTask();
    expect(result).toBeNull();
  });
});
