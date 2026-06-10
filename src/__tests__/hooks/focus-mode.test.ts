import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, updateTask, setTaskStatus } from '../../hooks/use-tasks';
import { maybeRefillFocus } from '../../hooks/use-focus-mode';
import { localDayKey, FOCUS_SET_SIZE } from '../../lib/focus-mode';

const DAY = 24 * 60 * 60 * 1000;

let listId: string;

beforeEach(async () => {
  await resetDb();
  const list = assertDefined(await createTaskList('Tasks', 'tasks'), 'list');
  listId = list.id;
});

async function focusedTasks() {
  const tasks = await db.tasks.toArray();
  return tasks.filter((t) => t.focusedAt != null);
}

describe('maybeRefillFocus', () => {
  it('fills up to FOCUS_SET_SIZE tasks, stamps the day, and records change-log entries', async () => {
    for (let i = 0; i < 5; i++) {
      await createTask(listId, { title: `Task ${i}` });
    }
    const now = Date.now();
    const changesBefore = await db.changeLog.count();

    await maybeRefillFocus(now);

    const focused = await focusedTasks();
    expect(focused).toHaveLength(FOCUS_SET_SIZE);
    expect(focused.every((t) => t.focusedAt === now)).toBe(true);
    // Each pick's updateTask stamps the field + records a change entry.
    expect(focused.every((t) => t.fieldTimestamps?.focusedAt === t.updatedAt)).toBe(true);
    expect(await db.changeLog.count()).toBe(changesBefore + FOCUS_SET_SIZE);

    const local = assertDefined(await db.localSettings.get('local'), 'localSettings');
    expect(local.lastFocusRefillDay).toBe(localDayKey(now));
  });

  it('is a no-op when called again the same day (no refill after a mid-day completion)', async () => {
    for (let i = 0; i < 5; i++) {
      await createTask(listId, { title: `Task ${i}` });
    }
    const now = Date.now();
    await maybeRefillFocus(now);

    const [first] = await focusedTasks();
    await setTaskStatus(first.id, 'done');
    await maybeRefillFocus(now + 60_000); // later the same day

    const focused = await focusedTasks();
    // The done task keeps focusedAt until tomorrow's cleanup; nothing new was pulled in.
    expect(focused).toHaveLength(FOCUS_SET_SIZE);
    expect(focused.filter((t) => t.status !== 'done')).toHaveLength(FOCUS_SET_SIZE - 1);
  });

  it('next day: clears focusedAt on completed/blocked members and refills the slots', async () => {
    for (let i = 0; i < 6; i++) {
      await createTask(listId, { title: `Task ${i}` });
    }
    const now = Date.now();
    await maybeRefillFocus(now);

    const members = await focusedTasks();
    await setTaskStatus(members[0].id, 'done');
    await setTaskStatus(members[1].id, 'blocked');

    await maybeRefillFocus(now + DAY);

    const focused = await focusedTasks();
    expect(focused).toHaveLength(FOCUS_SET_SIZE);
    expect(focused.every((t) => t.status === 'todo')).toBe(true);
    const doneTask = assertDefined(await db.tasks.get(members[0].id), 'done member');
    const blockedTask = assertDefined(await db.tasks.get(members[1].id), 'blocked member');
    expect(doneTask.focusedAt).toBeUndefined();
    expect(blockedTask.focusedAt).toBeUndefined();
  });

  it('trims a cross-device over-fill to the oldest-focused members, deterministically', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const task = assertDefined(await createTask(listId, { title: `Task ${i}` }), 'task');
      ids.push(task.id);
    }
    const now = Date.now();
    // Simulate two devices having refilled independently: 5 focused tasks.
    for (let i = 0; i < 5; i++) {
      await updateTask(ids[i], { focusedAt: now - (5 - i) * 1000 });
    }

    await maybeRefillFocus(now);

    const focused = await focusedTasks();
    expect(focused.map((t) => t.id).sort()).toEqual(ids.slice(0, FOCUS_SET_SIZE).sort());
  });

  it('a full set surviving the day rollover still stamps the day and keeps its members', async () => {
    for (let i = 0; i < 5; i++) {
      await createTask(listId, { title: `Task ${i}` });
    }
    const now = Date.now();
    await maybeRefillFocus(now);
    const memberIds = (await focusedTasks()).map((t) => t.id).sort();

    await maybeRefillFocus(now + DAY);

    expect((await focusedTasks()).map((t) => t.id).sort()).toEqual(memberIds);
    const local = assertDefined(await db.localSettings.get('local'), 'localSettings');
    expect(local.lastFocusRefillDay).toBe(localDayKey(now + DAY));
  });

  it('urgency mix: overdue and due-today claim slots, the third comes from the backlog', async () => {
    const now = Date.now();
    const overdue = assertDefined(
      await createTask(listId, { title: 'Overdue', dueDate: now - 2 * DAY }), 'overdue');
    const dueToday = assertDefined(
      await createTask(listId, { title: 'Due today', dueDate: now }), 'dueToday');
    const starred = assertDefined(await createTask(listId, { title: 'Starred' }), 'starred');
    await updateTask(starred.id, { starred: true });
    const plain = assertDefined(await createTask(listId, { title: 'Plain' }), 'plain');

    await maybeRefillFocus(now);

    const focusedIds = (await focusedTasks()).map((t) => t.id);
    expect(focusedIds).toHaveLength(FOCUS_SET_SIZE);
    expect(focusedIds).toContain(overdue.id);
    expect(focusedIds).toContain(dueToday.id);
    // The reserved backlog slot goes to the plain task, not the (urgent) starred one.
    expect(focusedIds).toContain(plain.id);
  });

  it('fills fewer slots when fewer tasks are eligible', async () => {
    await createTask(listId, { title: 'Only one' });
    await maybeRefillFocus(Date.now());
    expect(await focusedTasks()).toHaveLength(1);
  });
});
