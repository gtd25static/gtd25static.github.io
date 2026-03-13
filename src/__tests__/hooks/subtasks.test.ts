import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import {
  createSubtask, setSubtaskStatus, deleteSubtask, restoreSubtask,
  convertSubtaskToTask, reorderSubtasks,
} from '../../hooks/use-subtasks';

let listId: string;
let taskId: string;

beforeEach(async () => {
  await resetDb();
  const list = await createTaskList('List');
  listId = list.id;
  const task = assertDefined(await createTask(listId, { title: 'Parent Task' }));
  taskId = task.id;
});

describe('createSubtask', () => {
  it('creates a subtask with correct fields', async () => {
    const sub = assertDefined(await createSubtask(taskId, { title: 'My Sub' }));
    expect(sub.title).toBe('My Sub');
    expect(sub.taskId).toBe(taskId);
    expect(sub.status).toBe('todo');
    expect(sub.deletedAt).toBeUndefined();
  });

  it('auto-increments order', async () => {
    const s1 = assertDefined(await createSubtask(taskId, { title: 'First' }));
    const s2 = assertDefined(await createSubtask(taskId, { title: 'Second' }));
    expect(s1.order).toBe(0);
    expect(s2.order).toBe(1);
  });

  it('records change in changelog', async () => {
    await createSubtask(taskId, { title: 'Test' });
    const entries = await db.changeLog.toArray();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.entityType === 'subtask' && e.operation === 'upsert')).toBe(true);
  });
});

describe('setSubtaskStatus', () => {
  it('sets working, clears other working subtasks globally', async () => {
    const list2 = await createTaskList('Other');
    const task2 = assertDefined(await createTask(list2.id, { title: 'Other Task' }));
    const sub1 = assertDefined(await createSubtask(taskId, { title: 'Sub 1' }));
    const sub2 = assertDefined(await createSubtask(task2.id, { title: 'Sub 2' }));

    await setSubtaskStatus(sub1.id, 'working');
    await setSubtaskStatus(sub2.id, 'working');

    const s1 = await db.subtasks.get(sub1.id);
    const s2 = await db.subtasks.get(sub2.id);
    expect(s1?.status).toBe('todo'); // cleared
    expect(s2?.status).toBe('working');
  });

  it('sets working, clears working tasks globally', async () => {
    await db.tasks.update(taskId, { status: 'working' });
    const sub = assertDefined(await createSubtask(taskId, { title: 'Sub' }));

    await setSubtaskStatus(sub.id, 'working');

    const updatedTask = await db.tasks.get(taskId);
    expect(updatedTask?.status).toBe('todo');
    const updatedSub = await db.subtasks.get(sub.id);
    expect(updatedSub?.status).toBe('working');
  });

  it('auto-completes parent when all subtasks done', async () => {
    const s1 = assertDefined(await createSubtask(taskId, { title: 'Sub 1' }));
    const s2 = assertDefined(await createSubtask(taskId, { title: 'Sub 2' }));

    await setSubtaskStatus(s1.id, 'done');
    // Parent should not be done yet
    let parent = await db.tasks.get(taskId);
    expect(parent?.status).toBe('todo');

    await setSubtaskStatus(s2.id, 'done');
    parent = await db.tasks.get(taskId);
    expect(parent?.status).toBe('done');
  });

  it('does NOT auto-complete when some subtasks are not done', async () => {
    const s1 = assertDefined(await createSubtask(taskId, { title: 'Sub 1' }));
    await createSubtask(taskId, { title: 'Sub 2' });

    await setSubtaskStatus(s1.id, 'done');
    const parent = await db.tasks.get(taskId);
    expect(parent?.status).toBe('todo');
  });

  it('ignores deleted subtasks in "all done" check', async () => {
    const s1 = assertDefined(await createSubtask(taskId, { title: 'Sub 1' }));
    const s2 = assertDefined(await createSubtask(taskId, { title: 'Sub 2' }));

    await deleteSubtask(s2.id);
    await setSubtaskStatus(s1.id, 'done');

    const parent = await db.tasks.get(taskId);
    expect(parent?.status).toBe('done');
  });
});

describe('deleteSubtask / restoreSubtask', () => {
  it('soft-deletes and restores a subtask', async () => {
    const sub = assertDefined(await createSubtask(taskId, { title: 'Test' }));
    await deleteSubtask(sub.id);
    let s = await db.subtasks.get(sub.id);
    expect(s?.deletedAt).toBeDefined();

    await restoreSubtask(sub.id);
    s = await db.subtasks.get(sub.id);
    expect(s?.deletedAt).toBeUndefined();
  });
});

describe('convertSubtaskToTask', () => {
  it('soft-deletes subtask and creates task in target list', async () => {
    const list2 = await createTaskList('Target');
    const sub = assertDefined(await createSubtask(taskId, { title: 'Convert Me', link: 'https://x.com' }));

    await convertSubtaskToTask(sub.id, list2.id);

    const deleted = await db.subtasks.get(sub.id);
    expect(deleted?.deletedAt).toBeDefined();

    const newTasks = await db.tasks.where('listId').equals(list2.id).toArray();
    expect(newTasks).toHaveLength(1);
    expect(newTasks[0].title).toBe('Convert Me');
    expect(newTasks[0].link).toBe('https://x.com');
  });

  it('maps working status to todo', async () => {
    const list2 = await createTaskList('Target');
    const sub = assertDefined(await createSubtask(taskId, { title: 'Working Sub' }));
    await setSubtaskStatus(sub.id, 'working');

    await convertSubtaskToTask(sub.id, list2.id);

    const newTasks = await db.tasks.where('listId').equals(list2.id).toArray();
    expect(newTasks[0].status).toBe('todo');
  });

  it('preserves other statuses', async () => {
    const list2 = await createTaskList('Target');
    const sub = assertDefined(await createSubtask(taskId, { title: 'Blocked Sub' }));
    await setSubtaskStatus(sub.id, 'blocked');

    await convertSubtaskToTask(sub.id, list2.id);

    const newTasks = await db.tasks.where('listId').equals(list2.id).toArray();
    expect(newTasks[0].status).toBe('blocked');
  });

  it('appends to end of target list', async () => {
    const list2 = await createTaskList('Target');
    await createTask(list2.id, { title: 'Existing' });
    const sub = assertDefined(await createSubtask(taskId, { title: 'Converted' }));

    await convertSubtaskToTask(sub.id, list2.id);

    const newTasks = await db.tasks.where('listId').equals(list2.id).sortBy('order');
    expect(newTasks[1].title).toBe('Converted');
    expect(newTasks[1].order).toBe(1);
  });
});

describe('reorderSubtasks', () => {
  it('assigns sequential order', async () => {
    const a = assertDefined(await createSubtask(taskId, { title: 'A' }));
    const b = assertDefined(await createSubtask(taskId, { title: 'B' }));
    const c = assertDefined(await createSubtask(taskId, { title: 'C' }));

    await reorderSubtasks([c.id, a.id, b.id]);

    const subs = await db.subtasks.where('taskId').equals(taskId).sortBy('order');
    expect(subs[0].id).toBe(c.id);
    expect(subs[1].id).toBe(a.id);
    expect(subs[2].id).toBe(b.id);
  });
});
