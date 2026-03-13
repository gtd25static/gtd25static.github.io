import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';
import { computeNextOccurrence, checkRecurringTasks } from '../../hooks/use-recurring';

let listId: string;

beforeEach(async () => {
  await resetDb();
  const list = await createTaskList('Recurring List');
  listId = list.id;
});

describe('computeNextOccurrence', () => {
  const base = new Date('2026-01-15T12:00:00Z').getTime();

  it('adds hours correctly', () => {
    const result = computeNextOccurrence(base, 6, 'hours');
    expect(result).toBe(base + 6 * 60 * 60 * 1000);
  });

  it('adds days correctly', () => {
    const result = computeNextOccurrence(base, 3, 'days');
    const expected = new Date('2026-01-18T12:00:00Z').getTime();
    expect(result).toBe(expected);
  });

  it('adds weeks correctly', () => {
    const result = computeNextOccurrence(base, 2, 'weeks');
    const expected = new Date('2026-01-29T12:00:00Z').getTime();
    expect(result).toBe(expected);
  });

  it('adds months correctly', () => {
    const result = computeNextOccurrence(base, 1, 'months');
    const expected = new Date('2026-02-15T12:00:00Z').getTime();
    expect(result).toBe(expected);
  });
});

describe('checkRecurringTasks', () => {
  it('resets done time-based task when nextOccurrence <= now', async () => {
    const past = Date.now() - 60_000;
    const task = assertDefined(
      await createTask(listId, {
        title: 'Recurring',
        recurrenceType: 'time-based',
        recurrenceInterval: 1,
        recurrenceUnit: 'days',
        nextOccurrence: past,
      }),
    );
    // Mark as done
    await db.tasks.update(task.id, { status: 'done', updatedAt: Date.now() });

    await checkRecurringTasks();

    const updated = await db.tasks.get(task.id);
    expect(updated?.status).toBe('todo');
    expect(updated?.nextOccurrence).toBeGreaterThan(past);
  });

  it('resets date-based task regardless of status when due', async () => {
    const past = Date.now() - 60_000;
    const task = assertDefined(
      await createTask(listId, {
        title: 'Date Recurring',
        recurrenceType: 'date-based',
        recurrenceInterval: 1,
        recurrenceUnit: 'weeks',
        nextOccurrence: past,
      }),
    );
    // Leave status as 'todo' — date-based should still reset
    await checkRecurringTasks();

    const updated = await db.tasks.get(task.id);
    expect(updated?.status).toBe('todo');
    expect(updated?.nextOccurrence).toBeGreaterThan(past);
  });

  it('does NOT reset time-based task that is not done', async () => {
    const past = Date.now() - 60_000;
    const task = assertDefined(
      await createTask(listId, {
        title: 'Not Done',
        recurrenceType: 'time-based',
        recurrenceInterval: 1,
        recurrenceUnit: 'days',
        nextOccurrence: past,
      }),
    );
    // status is 'todo' — time-based only resets done tasks

    await checkRecurringTasks();

    const updated = await db.tasks.get(task.id);
    expect(updated?.status).toBe('todo');
    // nextOccurrence should NOT have changed
    expect(updated?.nextOccurrence).toBe(past);
  });

  it('skips deleted tasks', async () => {
    const past = Date.now() - 60_000;
    const task = assertDefined(
      await createTask(listId, {
        title: 'Deleted Recurring',
        recurrenceType: 'time-based',
        recurrenceInterval: 1,
        recurrenceUnit: 'days',
        nextOccurrence: past,
      }),
    );
    await db.tasks.update(task.id, { status: 'done', deletedAt: Date.now(), updatedAt: Date.now() });

    await checkRecurringTasks();

    const updated = await db.tasks.get(task.id);
    expect(updated?.nextOccurrence).toBe(past); // unchanged
  });

  it('skips tasks without recurrence config', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Normal Task' }));
    const beforeUpdate = task.updatedAt;

    await checkRecurringTasks();

    const updated = await db.tasks.get(task.id);
    expect(updated?.updatedAt).toBe(beforeUpdate); // unchanged
  });

  it('resets subtasks to todo when parent recurs', async () => {
    const past = Date.now() - 60_000;
    const task = assertDefined(
      await createTask(listId, {
        title: 'Parent',
        recurrenceType: 'date-based',
        recurrenceInterval: 1,
        recurrenceUnit: 'days',
        nextOccurrence: past,
      }),
    );
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub1' }));
    await db.subtasks.update(sub.id, { status: 'done', updatedAt: Date.now() });

    await checkRecurringTasks();

    const updatedSub = await db.subtasks.get(sub.id);
    expect(updatedSub?.status).toBe('todo');
  });

  it('skips deleted subtasks during reset', async () => {
    const past = Date.now() - 60_000;
    const task = assertDefined(
      await createTask(listId, {
        title: 'Parent',
        recurrenceType: 'date-based',
        recurrenceInterval: 1,
        recurrenceUnit: 'days',
        nextOccurrence: past,
      }),
    );
    const sub = assertDefined(await createSubtask(task.id, { title: 'Deleted Sub' }));
    await db.subtasks.update(sub.id, { status: 'done', deletedAt: Date.now(), updatedAt: Date.now() });

    await checkRecurringTasks();

    const updatedSub = await db.subtasks.get(sub.id);
    expect(updatedSub?.status).toBe('done'); // unchanged because deleted
  });

  it('records changelog entries', async () => {
    const past = Date.now() - 60_000;
    assertDefined(
      await createTask(listId, {
        title: 'Logged',
        recurrenceType: 'date-based',
        recurrenceInterval: 1,
        recurrenceUnit: 'days',
        nextOccurrence: past,
      }),
    );

    const beforeCount = await db.changeLog.count();
    await checkRecurringTasks();
    const afterCount = await db.changeLog.count();

    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it('is a no-op when no tasks are due', async () => {
    const future = Date.now() + 86_400_000;
    assertDefined(
      await createTask(listId, {
        title: 'Future',
        recurrenceType: 'time-based',
        recurrenceInterval: 1,
        recurrenceUnit: 'days',
        nextOccurrence: future,
      }),
    );

    const beforeCount = await db.changeLog.count();
    await checkRecurringTasks();
    const afterCount = await db.changeLog.count();

    expect(afterCount).toBe(beforeCount);
  });
});
