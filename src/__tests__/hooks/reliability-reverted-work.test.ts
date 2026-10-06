import { db, cleanOrphans } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList, deleteTaskList } from '../../hooks/use-task-lists';
import { createTask, updateTask, setTaskStatus, deleteTask } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';
import { deleteTasksBatch } from '../../hooks/use-bulk-operations';
import { createMindmapFolder, createMindmap, createMindmapNode, deleteMindmapFolder, deleteMindmap, deleteMindmapNodeSubtree } from '../../hooks/use-mindmaps';
import { computeNextOccurrence, checkRecurringTasks } from '../../hooks/use-recurring';
import { expireCompletedItems } from '../../db/purge';
import { archiveOldCompleted } from '../../sync/conflict-resolution';
import { mergeEntity } from '../../sync/field-timestamps';
import type { SyncData, Task } from '../../db/models';

// Reliability review 2026-10-06, batch 1: work the user did that the app undid
// on its own — a recurring reset beating a completion made on another device,
// retention trashing long recurrences, a reopened task staying archived, and
// cascade deletes whose restore missed children on other devices.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let listId: string;

beforeEach(async () => {
  await resetDb();
  listId = (await createTaskList('Work')).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function recurringTask(overrides: Partial<Task>): Promise<Task> {
  const task = assertDefined(await createTask(listId, {
    title: 'Water the plants',
    recurrenceType: 'time-based',
    recurrenceInterval: 1,
    recurrenceUnit: 'days',
    nextOccurrence: overrides.nextOccurrence,
  }));
  // As in real use, the fields a reset touches were last set before the
  // occurrence (when the task was created or last completed).
  const before = (overrides.nextOccurrence ?? Date.now()) - 2 * DAY;
  const { fieldTimestamps, ...rest } = overrides;
  await db.tasks.update(task.id, {
    ...rest,
    fieldTimestamps: { ...(task.fieldTimestamps ?? {}), status: before, nextOccurrence: before, focusedAt: before, archived: before, ...(fieldTimestamps ?? {}) },
  });
  return assertDefined(await db.tasks.get(task.id));
}

describe('recurring reset (A1)', () => {
  it('stamps the reset with the occurrence, so a completion made later on another device wins', async () => {
    // The phone last synced yesterday: it still holds yesterday's completion and
    // today's 08:00 occurrence, and is opened at 19:00 — after the laptop reset
    // the task at 08:00 and the user completed it there at 09:00.
    const occurrence = Date.now() - 11 * HOUR;
    const task = await recurringTask({
      status: 'done',
      nextOccurrence: occurrence,
      fieldTimestamps: { status: occurrence - DAY + HOUR },
    });

    await checkRecurringTasks();

    const reset = assertDefined(await db.tasks.get(task.id));
    expect(reset.status).toBe('todo');
    expect(reset.fieldTimestamps?.status).toBe(occurrence);

    // The laptop's completion at 09:00 arrives.
    const laptop = { ...reset, status: 'done', fieldTimestamps: { ...reset.fieldTimestamps, status: occurrence + HOUR } };
    const merged = mergeEntity(reset as unknown as Record<string, unknown>, laptop as unknown as Record<string, unknown>, occurrence + HOUR);
    expect(merged?.status).toBe('done');
  });

  it('leaves the status alone when it was set after the occurrence', async () => {
    const occurrence = Date.now() - 3 * HOUR;
    const task = await recurringTask({
      recurrenceType: 'date-based',
      status: 'done',
      nextOccurrence: occurrence,
      fieldTimestamps: { status: occurrence + HOUR },
    });

    await checkRecurringTasks();

    const after = assertDefined(await db.tasks.get(task.id));
    expect(after.status).toBe('done');
    expect(after.fieldTimestamps?.status).toBe(occurrence + HOUR);
    expect(after.nextOccurrence).toBeGreaterThan(Date.now());
  });

  it('catches up every missed occurrence in one pass, on the same grid', async () => {
    const anchor = Date.now() - 5 * DAY - 2 * HOUR;
    const task = await recurringTask({ recurrenceType: 'date-based', nextOccurrence: anchor });

    await checkRecurringTasks();

    let expectedLast = anchor;
    let expectedNext = anchor;
    while (expectedNext <= Date.now()) {
      expectedLast = expectedNext;
      expectedNext = computeNextOccurrence(expectedNext, 1, 'days');
    }
    const after = assertDefined(await db.tasks.get(task.id));
    expect(after.nextOccurrence).toBe(expectedNext);
    expect(after.fieldTimestamps?.status).toBe(expectedLast);

    // A second check right after has nothing left to do.
    const entriesBefore = await db.changeLog.count();
    await checkRecurringTasks();
    expect(await db.changeLog.count()).toBe(entriesBefore);
  });

  it.each([
    ['a zero interval', { recurrenceInterval: 0 }],
    ['a negative interval', { recurrenceInterval: -2 }],
    ['a fractional interval', { recurrenceInterval: 0.5 }],
    ['an unknown unit', { recurrenceUnit: 'fortnights' as Task['recurrenceUnit'] }],
  ])('ignores a task with %s instead of resetting it every minute', async (_label, bad) => {
    const occurrence = Date.now() - HOUR;
    const task = await recurringTask({ recurrenceType: 'date-based', status: 'done', nextOccurrence: occurrence, ...bad });
    const entriesBefore = await db.changeLog.count();

    await checkRecurringTasks();

    const after = assertDefined(await db.tasks.get(task.id));
    expect(after.status).toBe('done');
    expect(after.nextOccurrence).toBe(occurrence);
    expect(await db.changeLog.count()).toBe(entriesBefore);
  });

  it('resets subtasks with the occurrence stamp too', async () => {
    const occurrence = Date.now() - 2 * HOUR;
    const task = await recurringTask({ status: 'done', nextOccurrence: occurrence, fieldTimestamps: { status: occurrence - DAY } });
    const sub = assertDefined(await createSubtask(task.id, { title: 'Step' }));
    await db.subtasks.update(sub.id, { status: 'done', fieldTimestamps: { ...sub.fieldTimestamps, status: occurrence - DAY } });

    await checkRecurringTasks();

    const after = assertDefined(await db.subtasks.get(sub.id));
    expect(after.status).toBe('todo');
    expect(after.fieldTimestamps?.status).toBe(occurrence);
  });
});

describe('monthly recurrence (B18)', () => {
  it('lands on the last day of a shorter month instead of spilling into the next', () => {
    const jan31 = new Date(2026, 0, 31, 9, 30).getTime();
    expect(computeNextOccurrence(jan31, 1, 'months')).toBe(new Date(2026, 1, 28, 9, 30).getTime());
    expect(computeNextOccurrence(jan31, 2, 'months')).toBe(new Date(2026, 2, 31, 9, 30).getTime());
    const aug31 = new Date(2026, 7, 31, 9, 30).getTime();
    expect(computeNextOccurrence(aug31, 1, 'months')).toBe(new Date(2026, 8, 30, 9, 30).getTime());
  });
});

describe('retention of recurring tasks (A2)', () => {
  it('never sends a recurring task to the Trash, however long ago it was completed', async () => {
    const longAgo = Date.now() - 400 * DAY;
    const recurring = await recurringTask({
      recurrenceInterval: 24, recurrenceUnit: 'months',
      status: 'done', completedAt: longAgo, nextOccurrence: Date.now() + 300 * DAY,
    });
    const plain = assertDefined(await createTask(listId, { title: 'One-off' }));
    await db.tasks.update(plain.id, { status: 'done', completedAt: longAgo });

    await expireCompletedItems();

    expect((await db.tasks.get(recurring.id))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get(plain.id))?.deletedAt).toBeDefined();
  });

  it('compaction does not archive a recurring task waiting for its next occurrence', () => {
    const longAgo = Date.now() - 200 * DAY;
    const data = {
      tasks: [
        { id: 'r', listId: 'l', title: 'Yearly', status: 'done', order: 0, createdAt: 0, updatedAt: longAgo, completedAt: longAgo, recurrenceType: 'time-based', recurrenceInterval: 12, recurrenceUnit: 'months' },
        { id: 'p', listId: 'l', title: 'Plain', status: 'done', order: 1, createdAt: 0, updatedAt: longAgo, completedAt: longAgo },
      ],
    } as unknown as SyncData;

    const out = archiveOldCompleted(data);

    expect(out.tasks.find((t) => t.id === 'r')?.archived).toBeFalsy();
    expect(out.tasks.find((t) => t.id === 'p')?.archived).toBe(true);
  });
});

describe('archived flag on a task that is no longer done (M2)', () => {
  it('reopening an archived task un-archives it', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Old' }));
    await db.tasks.update(task.id, { status: 'done', archived: true, completedAt: Date.now() - 100 * DAY });

    await setTaskStatus(task.id, 'todo');

    const after = assertDefined(await db.tasks.get(task.id));
    expect(after.status).toBe('todo');
    expect(after.archived).toBeFalsy();
    expect(after.fieldTimestamps?.archived).toBeGreaterThan(0);
  });

  it('the recurring reset un-archives the task it brings back', async () => {
    const occurrence = Date.now() - HOUR;
    const task = await recurringTask({ status: 'done', archived: true, nextOccurrence: occurrence, fieldTimestamps: { status: occurrence - 100 * DAY } });

    await checkRecurringTasks();

    const after = assertDefined(await db.tasks.get(task.id));
    expect(after.status).toBe('todo');
    expect(after.archived).toBeFalsy();
  });

  it('startup repair un-archives open tasks but leaves resolved follow-ups alone', async () => {
    const open = assertDefined(await createTask(listId, { title: 'Reopened long ago' }));
    await db.tasks.update(open.id, { status: 'todo', archived: true });
    const followUps = await createTaskList('People', 'follow-ups');
    const resolved = assertDefined(await createTask(followUps.id, { title: 'Ask Ana' }));
    await db.tasks.update(resolved.id, { archived: true });

    await cleanOrphans();

    expect((await db.tasks.get(open.id))?.archived).toBeFalsy();
    expect((await db.tasks.get(resolved.id))?.archived).toBe(true);
  });
});

describe('cascade deletes share one time with their change entries (M4)', () => {
  // A clock that moves on every read: the rows' deletedAt and the entries'
  // timestamp only match if the delete hands its own time to the change log.
  function tickingClock() {
    let t = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 7));
  }

  async function expectEntriesMatchRows(table: 'taskLists' | 'tasks' | 'subtasks' | 'mindmapFolders' | 'mindmaps' | 'mindmapNodes', ids: string[]) {
    for (const id of ids) {
      const row = assertDefined(await (db[table] as unknown as { get(id: string): Promise<{ deletedAt?: number } | undefined> }).get(id));
      const entry = assertDefined(await db.changeLog.filter((e) => e.entityId === id && e.operation === 'delete').first());
      expect(row.deletedAt).toBeDefined();
      expect(entry.timestamp).toBe(row.deletedAt);
    }
  }

  it('deleting a list', async () => {
    const task = assertDefined(await createTask(listId, { title: 'A' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'a1' }));
    tickingClock();
    await deleteTaskList(listId);
    await expectEntriesMatchRows('taskLists', [listId]);
    await expectEntriesMatchRows('tasks', [task.id]);
    await expectEntriesMatchRows('subtasks', [sub.id]);
  });

  it('deleting a task, one or in bulk', async () => {
    const one = assertDefined(await createTask(listId, { title: 'A' }));
    const sub = assertDefined(await createSubtask(one.id, { title: 'a1' }));
    const two = assertDefined(await createTask(listId, { title: 'B' }));
    tickingClock();
    await deleteTask(one.id);
    await deleteTasksBatch([two.id]);
    await expectEntriesMatchRows('tasks', [one.id, two.id]);
    await expectEntriesMatchRows('subtasks', [sub.id]);
  });

  it('deleting a mind map folder, a map, a branch', async () => {
    const folder = assertDefined(await createMindmapFolder('F'));
    const inFolder = assertDefined(await createMindmap('In folder', folder.id));
    const map = assertDefined(await createMindmap('Loose'));
    const root = assertDefined(await db.mindmapNodes.where('mapId').equals(map.id).first());
    const branch = assertDefined(await createMindmapNode(map.id, root.id, 'Branch'));
    tickingClock();
    await deleteMindmapNodeSubtree(branch.id);
    await deleteMindmapFolder(folder.id);
    await deleteMindmap(map.id);
    await expectEntriesMatchRows('mindmapNodes', [branch.id]);
    await expectEntriesMatchRows('mindmapFolders', [folder.id]);
    await expectEntriesMatchRows('mindmaps', [inFolder.id, map.id]);
  });
});

describe('saving an edit with nothing in it (M1)', () => {
  it('updateTask with no fields writes nothing', async () => {
    const task = assertDefined(await createTask(listId, { title: 'A' }));
    const before = await db.changeLog.count();
    await updateTask(task.id, {});
    expect(await db.changeLog.count()).toBe(before);
    expect((await db.tasks.get(task.id))?.updatedAt).toBe(task.updatedAt);
  });
});
