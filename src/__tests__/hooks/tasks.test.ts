import { db } from '../../db';
import { MAX_TITLE_LENGTH } from '../../lib/constants';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, updateTask, setTaskStatus, deleteTask, restoreTask, moveTaskToList, reorderTasks } from '../../hooks/use-tasks';
import { createSubtask, deleteSubtask } from '../../hooks/use-subtasks';
import { tick, loggedIds } from '../helpers/cascade-fixtures';

let listId: string;

beforeEach(async () => {
  await resetDb();
  const list = await createTaskList('Test List');
  listId = list.id;
});

describe('createTask', () => {
  it('creates a task with correct fields', async () => {
    const task = assertDefined(await createTask(listId, { title: 'My Task', description: 'Desc', link: 'https://x.com' }));
    expect(task.title).toBe('My Task');
    expect(task.description).toBe('Desc');
    expect(task.link).toBe('https://x.com');
    expect(task.status).toBe('todo');
    expect(task.listId).toBe(listId);
    expect(task.deletedAt).toBeUndefined();
  });

  it('auto-increments order within list', async () => {
    const t1 = assertDefined(await createTask(listId, { title: 'First' }));
    const t2 = assertDefined(await createTask(listId, { title: 'Second' }));
    expect(t1.order).toBe(0);
    expect(t2.order).toBe(1);
  });

  it('records change in changelog', async () => {
    await createTask(listId, { title: 'Test' });
    const entries = await db.changeLog.toArray();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.entityType === 'task' && e.operation === 'upsert')).toBe(true);
  });
});

describe('updateTask', () => {
  it('updates fields and updatedAt', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Original' }));
    const before = task.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    await updateTask(task.id, { title: 'Updated' });
    const updated = await db.tasks.get(task.id);
    expect(updated?.title).toBe('Updated');
    expect(updated!.updatedAt).toBeGreaterThan(before);
  });

  it('preserves unspecified fields', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Keep', description: 'Keep this' }));
    await updateTask(task.id, { title: 'Changed' });
    const updated = await db.tasks.get(task.id);
    expect(updated?.description).toBe('Keep this');
  });
});

describe('setTaskStatus', () => {
  it('changes status', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Test' }));
    await setTaskStatus(task.id, 'done');
    const updated = await db.tasks.get(task.id);
    expect(updated?.status).toBe('done');
  });
});

describe('deleteTask', () => {
  it('soft-deletes task and cascades to subtasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Doomed' }));
    await createSubtask(task.id, { title: 'Sub' });
    await deleteTask(task.id);
    const deleted = await db.tasks.get(task.id);
    expect(deleted?.deletedAt).toBeDefined();
    const subs = await db.subtasks.where('taskId').equals(task.id).toArray();
    expect(subs[0].deletedAt).toBeDefined();
  });
});

describe('restoreTask', () => {
  it('restores task and cascades to subtasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Restore' }));
    await createSubtask(task.id, { title: 'Sub' });
    await deleteTask(task.id);
    await restoreTask(task.id);
    const restored = await db.tasks.get(task.id);
    expect(restored?.deletedAt).toBeUndefined();
    const subs = await db.subtasks.where('taskId').equals(task.id).toArray();
    expect(subs[0].deletedAt).toBeUndefined();
  });
});

describe('task delete / restore vs. subtasks deleted earlier', () => {
  async function seedTaskWithDeletedSubtask() {
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    const keepSub = assertDefined(await createSubtask(task.id, { title: 'Keep' }));
    const goneSub = assertDefined(await createSubtask(task.id, { title: 'Deleted earlier' }));
    await deleteSubtask(goneSub.id);
    const goneAt = assertDefined((await db.subtasks.get(goneSub.id))?.deletedAt);
    await tick();
    return { task, keepSub, goneSub, goneAt };
  }

  it('deleteTask keeps the deletedAt of subtasks deleted before and logs no delete for them', async () => {
    const s = await seedTaskWithDeletedSubtask();
    await db.changeLog.clear();

    await deleteTask(s.task.id);

    const taskDeletedAt = assertDefined((await db.tasks.get(s.task.id))?.deletedAt);
    expect((await db.subtasks.get(s.keepSub.id))?.deletedAt).toBe(taskDeletedAt);
    expect((await db.subtasks.get(s.goneSub.id))?.deletedAt).toBe(s.goneAt);
    expect(await loggedIds('delete')).toEqual([s.task.id, s.keepSub.id].sort());
  });

  it('restoreTask (undo) brings back only the subtasks the task delete took', async () => {
    const s = await seedTaskWithDeletedSubtask();
    await deleteTask(s.task.id);
    await db.changeLog.clear();

    await restoreTask(s.task.id);

    expect((await db.tasks.get(s.task.id))?.deletedAt).toBeUndefined();
    expect((await db.subtasks.get(s.keepSub.id))?.deletedAt).toBeUndefined();
    expect((await db.subtasks.get(s.goneSub.id))?.deletedAt).toBe(s.goneAt);
    expect(await loggedIds('upsert')).toEqual([s.task.id, s.keepSub.id].sort());
  });

  it('deleting a task that is already deleted keeps its deletedAt and logs nothing', async () => {
    const s = await seedTaskWithDeletedSubtask();
    await deleteTask(s.task.id);
    const firstAt = (await db.tasks.get(s.task.id))?.deletedAt;
    await db.changeLog.clear();
    await tick();

    await deleteTask(s.task.id);

    expect((await db.tasks.get(s.task.id))?.deletedAt).toBe(firstAt);
    expect(await db.changeLog.count()).toBe(0);
  });
});

describe('moveTaskToList', () => {
  it('changes listId and appends to end', async () => {
    const list2 = await createTaskList('Other List');
    await createTask(list2.id, { title: 'Existing' });
    const task = assertDefined(await createTask(listId, { title: 'Moving' }));

    await moveTaskToList(task.id, list2.id);

    const moved = await db.tasks.get(task.id);
    expect(moved?.listId).toBe(list2.id);
    expect(moved?.order).toBe(1); // appended after existing
  });

  it('leaves task state alone when moving between task lists', async () => {
    const list2 = await createTaskList('Other List');
    const task = assertDefined(await createTask(listId, {
      title: 'Blocked', recurrenceType: 'date-based', recurrenceInterval: 1, recurrenceUnit: 'weeks', nextOccurrence: Date.now() + 1000,
    }));
    await setTaskStatus(task.id, 'blocked');

    expect(await moveTaskToList(task.id, list2.id)).toBe(true);

    const moved = assertDefined(await db.tasks.get(task.id));
    expect(moved.status).toBe('blocked');
    expect(moved.blockedAt).toBeDefined();
    expect(moved.recurrenceType).toBe('date-based');
  });
});

describe('moveTaskToList across list types', () => {
  let followUpListId: string;

  beforeEach(async () => {
    followUpListId = (await createTaskList('People', 'follow-ups')).id;
  });

  it('turns a task into an active follow-up, keeping its content', async () => {
    const dueDate = Date.now() + 86_400_000;
    const task = assertDefined(await createTask(listId, {
      title: 'Ask Ana', description: 'about the budget', links: [{ url: 'https://x.com' }], dueDate,
    }));
    await updateTask(task.id, { starred: true, hasWarning: true });

    expect(await moveTaskToList(task.id, followUpListId)).toBe(true);

    const moved = assertDefined(await db.tasks.get(task.id));
    expect(moved.listId).toBe(followUpListId);
    expect(moved.status).toBe('todo');
    expect(moved.archived).toBeFalsy();
    expect(moved.title).toBe('Ask Ana');
    expect(moved.description).toBe('about the budget');
    expect(moved.links).toEqual([{ url: 'https://x.com' }]);
    expect(moved.dueDate).toBe(dueDate);
    expect(moved.starred).toBe(true);
    expect(moved.hasWarning).toBeTruthy(); // stored as 1 (db/warning-index.ts)
  });

  it('lifts the blocked state, which a follow-up cannot show or clear', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Blocked' }));
    await setTaskStatus(task.id, 'blocked');

    await moveTaskToList(task.id, followUpListId);

    const moved = assertDefined(await db.tasks.get(task.id));
    expect(moved.status).toBe('todo');
    expect(moved.blockedAt).toBeUndefined();
    // Stamped, so the unblock wins over an older remote value on sync.
    expect(moved.fieldTimestamps?.status).toBe(moved.updatedAt);
    expect(moved.fieldTimestamps?.blockedAt).toBe(moved.updatedAt);
  });

  it('turns a done task into a resolved follow-up', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Done' }));
    await setTaskStatus(task.id, 'done');

    await moveTaskToList(task.id, followUpListId);

    const moved = assertDefined(await db.tasks.get(task.id));
    expect(moved.archived).toBe(true);
    expect(moved.status).toBe('todo');
  });

  it('drops recurrence, which follow-up lists do not run', async () => {
    const task = assertDefined(await createTask(listId, {
      title: 'Weekly', recurrenceType: 'time-based', recurrenceInterval: 1, recurrenceUnit: 'weeks', nextOccurrence: Date.now() - 1000,
    }));

    await moveTaskToList(task.id, followUpListId);

    const moved = assertDefined(await db.tasks.get(task.id));
    expect(moved.recurrenceType).toBeUndefined();
    expect(moved.recurrenceInterval).toBeUndefined();
    expect(moved.recurrenceUnit).toBeUndefined();
    expect(moved.nextOccurrence).toBeUndefined();
    expect(moved.fieldTimestamps?.recurrenceType).toBe(moved.updatedAt);
  });

  it('refuses to turn a task with subtasks into a follow-up', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    await createSubtask(task.id, { title: 'Child' });
    const changesBefore = await db.changeLog.count();

    expect(await moveTaskToList(task.id, followUpListId)).toBe(false);

    const unmoved = assertDefined(await db.tasks.get(task.id));
    expect(unmoved.listId).toBe(listId);
    expect(await db.changeLog.count()).toBe(changesBefore);
  });

  it('allows it once the subtasks are deleted', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Child' }));
    await db.subtasks.update(sub.id, { deletedAt: Date.now() });

    expect(await moveTaskToList(task.id, followUpListId)).toBe(true);
    expect((await db.tasks.get(task.id))?.listId).toBe(followUpListId);
  });

  it('turns a follow-up into a task, keeping its history and snooze for a trip back', async () => {
    const fu = assertDefined(await createTask(followUpListId, { title: 'Topic' }));
    const until = Date.now() + 86_400_000;
    const discussionLog = [{ id: 'd1', at: Date.now(), note: 'talked' }];
    await updateTask(fu.id, { pingedAt: Date.now(), pingCooldown: 'custom', pingCooldownUntil: until, discussionLog, snoozeCadence: '6d' });

    expect(await moveTaskToList(fu.id, listId)).toBe(true);

    const moved = assertDefined(await db.tasks.get(fu.id));
    expect(moved.listId).toBe(listId);
    expect(moved.status).toBe('todo');
    expect(moved.discussionLog).toEqual(discussionLog);
    expect(moved.pingCooldownUntil).toBe(until);
    expect(moved.snoozeCadence).toBe('6d');
  });

  it('turns a resolved follow-up into a done task', async () => {
    const fu = assertDefined(await createTask(followUpListId, { title: 'Resolved' }));
    await updateTask(fu.id, { archived: true });

    await moveTaskToList(fu.id, listId);

    const moved = assertDefined(await db.tasks.get(fu.id));
    expect(moved.archived).toBeFalsy();
    expect(moved.status).toBe('done');
    expect(moved.completedAt).toBeDefined();
  });

  it('records the translated state in the change log', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Blocked' }));
    await setTaskStatus(task.id, 'blocked');

    await moveTaskToList(task.id, followUpListId);

    const entries = await db.changeLog.orderBy('timestamp').toArray();
    const last = entries.filter((e) => e.entityId === task.id).at(-1);
    expect(last?.data?.listId).toBe(followUpListId);
    expect(last?.data?.status).toBe('todo');
  });

  it('refuses a missing target list', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Stay' }));
    expect(await moveTaskToList(task.id, 'no-such-list')).toBe(false);
    expect((await db.tasks.get(task.id))?.listId).toBe(listId);
  });
});

describe('reorderTasks', () => {
  it('assigns sequential order', async () => {
    const a = assertDefined(await createTask(listId, { title: 'A' }));
    const b = assertDefined(await createTask(listId, { title: 'B' }));
    const c = assertDefined(await createTask(listId, { title: 'C' }));

    await reorderTasks([c.id, a.id, b.id]);

    const tasks = await db.tasks.orderBy('order').toArray();
    expect(tasks[0].id).toBe(c.id);
    expect(tasks[1].id).toBe(a.id);
    expect(tasks[2].id).toBe(b.id);
  });
});

describe('task title length', () => {
  it('is capped at MAX_TITLE_LENGTH on create and on update (inline edits went through at 900)', async () => {
    const list = await createTaskList('L');
    const task = assertDefined(await createTask(list.id, { title: 'x'.repeat(900) }));
    expect((await db.tasks.get(task.id))?.title).toHaveLength(MAX_TITLE_LENGTH);
    await updateTask(task.id, { title: 'y'.repeat(900) });
    expect((await db.tasks.get(task.id))?.title).toHaveLength(MAX_TITLE_LENGTH);
  });
});
