import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, updateTask, setTaskStatus, deleteTask, moveTaskToList } from '../../hooks/use-tasks';
import { maybeRefillFocus, maintainFocusSet } from '../../hooks/use-focus-mode';
import { checkRecurringTasks } from '../../hooks/use-recurring';
import { updateLocalSettings } from '../../hooks/use-settings';
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

describe('maintainFocusSet', () => {
  async function liveFocused() {
    return (await focusedTasks()).filter((t) => t.status === 'todo' && !t.deletedAt);
  }

  /** Refill with 5 plain tasks and return the focus members. */
  async function refillWithPlainTasks(now: number, count = 5) {
    for (let i = 0; i < count; i++) {
      await createTask(listId, { title: `Task ${i}` });
    }
    await maybeRefillFocus(now);
    return focusedTasks();
  }

  it('is gated until the daily refresh has stamped today', async () => {
    for (let i = 0; i < 5; i++) {
      await createTask(listId, { title: `Task ${i}` });
    }
    const now = Date.now();

    // (i) fresh DB: no daily refresh yet → maintenance must not pre-empt it.
    await maintainFocusSet(now);
    expect(await focusedTasks()).toHaveLength(0);
    const local = assertDefined(await db.localSettings.get('local'), 'localSettings');
    expect(local.lastFocusRefillDay).toBeUndefined();

    // (ii) stale stamp (yesterday): still a no-op until today's refresh runs.
    await updateLocalSettings({ lastFocusRefillDay: localDayKey(now - DAY) });
    await maintainFocusSet(now);
    expect(await focusedTasks()).toHaveLength(0);
  });

  it('writes nothing on a quiet tick (steady state)', async () => {
    const now = Date.now();
    await refillWithPlainTasks(now);
    const changesBefore = await db.changeLog.count();

    await maintainFocusSet(now + 60_000);

    expect(await db.changeLog.count()).toBe(changesBefore);
    expect(await focusedTasks()).toHaveLength(FOCUS_SET_SIZE);
  });

  it('repairs a recurring-reset leak the same tick, without oscillating', async () => {
    const now = Date.now();
    const recurring = assertDefined(
      await createTask(listId, { title: 'Recurring', dueDate: now - 2 * DAY }), 'recurring');
    await updateTask(recurring.id, {
      recurrenceType: 'date-based',
      recurrenceInterval: 1,
      recurrenceUnit: 'weeks',
      nextOccurrence: now - 1000,
    });
    for (let i = 0; i < 4; i++) {
      await createTask(listId, { title: `Task ${i}` });
    }
    await maybeRefillFocus(now);
    expect((await focusedTasks()).map((t) => t.id)).toContain(recurring.id); // rank-0 urgent

    await checkRecurringTasks(); // reset clears its focusedAt → set leaks to 2
    expect(await focusedTasks()).toHaveLength(FOCUS_SET_SIZE - 1);

    await maintainFocusSet(now + 60_000);

    const focused = await focusedTasks();
    expect(focused).toHaveLength(FOCUS_SET_SIZE);
    // Still the only urgent candidate → deterministically re-picked.
    expect(focused.map((t) => t.id)).toContain(recurring.id);

    // No oscillation: nextOccurrence advanced past now, so another pass is silent.
    const changesBefore = await db.changeLog.count();
    await checkRecurringTasks();
    await maintainFocusSet(now + 120_000);
    expect(await db.changeLog.count()).toBe(changesBefore);
  });

  it('repairs a blocked member without stale-clearing its focusedAt', async () => {
    const now = Date.now();
    const [first] = await refillWithPlainTasks(now);

    await setTaskStatus(first.id, 'blocked');
    await maintainFocusSet(now + 60_000);

    expect(await liveFocused()).toHaveLength(FOCUS_SET_SIZE);
    // The blocked carrier keeps focusedAt — stale-clearing is the daily pass's job.
    const blocked = assertDefined(await db.tasks.get(first.id), 'blocked member');
    expect(blocked.focusedAt).not.toBeUndefined();
  });

  it('repairs a member moved to a follow-ups list', async () => {
    const now = Date.now();
    const fuList = assertDefined(await createTaskList('Follow ups', 'follow-ups'), 'fu list');
    const [first] = await refillWithPlainTasks(now);

    await moveTaskToList(first.id, fuList.id);
    await maintainFocusSet(now + 60_000);

    const tasks = await db.tasks.toArray();
    const liveInTaskLists = tasks.filter(
      (t) => t.focusedAt != null && t.listId === listId && t.status === 'todo',
    );
    expect(liveInTaskLists).toHaveLength(FOCUS_SET_SIZE);
    const moved = assertDefined(await db.tasks.get(first.id), 'moved member');
    expect(moved.focusedAt).not.toBeUndefined();
  });

  it('does NOT repair a completed member — the slot is held for the day', async () => {
    const now = Date.now();
    const [first] = await refillWithPlainTasks(now);

    await setTaskStatus(first.id, 'done');
    const changesBefore = await db.changeLog.count();
    await maintainFocusSet(now + 60_000);

    expect(await db.changeLog.count()).toBe(changesBefore);
    const focused = await focusedTasks();
    expect(focused).toHaveLength(FOCUS_SET_SIZE); // 1 done carrier + 2 live
    expect(focused.filter((t) => t.status === 'todo')).toHaveLength(FOCUS_SET_SIZE - 1);
  });

  it('preserves the all-done celebration: three completions trigger no top-up', async () => {
    const now = Date.now();
    const members = await refillWithPlainTasks(now);

    for (const m of members) {
      await setTaskStatus(m.id, 'done');
    }
    const changesBefore = await db.changeLog.count();
    await maintainFocusSet(now + 60_000);

    expect(await db.changeLog.count()).toBe(changesBefore);
    expect(await liveFocused()).toHaveLength(0); // celebration state, not a refill
    expect(await focusedTasks()).toHaveLength(FOCUS_SET_SIZE); // held carriers intact
  });

  it('releases the slot when a done-today member is deleted', async () => {
    const now = Date.now();
    const [first] = await refillWithPlainTasks(now);

    await setTaskStatus(first.id, 'done');
    await deleteTask(first.id);
    await maintainFocusSet(now + 60_000);

    expect(await liveFocused()).toHaveLength(FOCUS_SET_SIZE);
    // Deleted carrier keeps focusedAt until the daily stale-clear.
    const deleted = assertDefined(await db.tasks.get(first.id), 'deleted member');
    expect(deleted.focusedAt).not.toBeUndefined();
  });

  it('trims a cross-device over-fill mid-day to the oldest-focused members', async () => {
    const now = Date.now();
    const members = await refillWithPlainTasks(now);
    const extra1 = assertDefined(await createTask(listId, { title: 'Extra 1' }), 'extra1');
    const extra2 = assertDefined(await createTask(listId, { title: 'Extra 2' }), 'extra2');
    await updateTask(extra1.id, { focusedAt: now + 1000 });
    await updateTask(extra2.id, { focusedAt: now + 2000 });

    await maintainFocusSet(now + 60_000);

    const focusedIds = (await focusedTasks()).map((t) => t.id).sort();
    expect(focusedIds).toEqual(members.map((t) => t.id).sort());
  });

  it('held + leaked slots combine: exactly one pick repairs the leak', async () => {
    const now = Date.now();
    const [first, second] = await refillWithPlainTasks(now);

    await setTaskStatus(first.id, 'done'); // held
    await updateTask(second.id, { focusedAt: undefined }); // leak (any non-completion exit)
    const changesBefore = await db.changeLog.count();
    await maintainFocusSet(now + 60_000);

    expect(await db.changeLog.count()).toBe(changesBefore + 1); // exactly one pick
    const focused = await focusedTasks();
    expect(focused).toHaveLength(FOCUS_SET_SIZE); // 1 done + 2 live
    expect(focused.filter((t) => t.status === 'todo')).toHaveLength(2);
  });

  it('overlapping invocations pick only once (in-flight guard)', async () => {
    const now = Date.now();
    const [first] = await refillWithPlainTasks(now);
    await updateTask(first.id, { focusedAt: undefined }); // leak one slot

    await Promise.all([maintainFocusSet(now + 60_000), maintainFocusSet(now + 60_001)]);

    expect(await liveFocused()).toHaveLength(FOCUS_SET_SIZE);
    expect(await focusedTasks()).toHaveLength(FOCUS_SET_SIZE); // no double-pick 4th carrier
  });
});
