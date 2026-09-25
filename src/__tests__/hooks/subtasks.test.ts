import { db } from '../../db';
import { MAX_TITLE_LENGTH } from '../../lib/constants';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import {
  createSubtask, setSubtaskStatus, deleteSubtask, restoreSubtask, updateSubtask,
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

  it('persists additional links from the new-subtask form', async () => {
    const links = [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.com/b' }];
    const sub = assertDefined(await createSubtask(taskId, { title: 'Linked', links }));
    expect((await db.subtasks.get(sub.id))?.links).toEqual(links);
    const entry = (await db.changeLog.toArray()).find((e) => e.entityId === sub.id);
    expect((entry?.data as { links?: unknown })?.links).toEqual(links);
  });

  it('records change in changelog', async () => {
    await createSubtask(taskId, { title: 'Test' });
    const entries = await db.changeLog.toArray();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.entityType === 'subtask' && e.operation === 'upsert')).toBe(true);
  });
});

describe('setSubtaskStatus', () => {
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

describe('parent completion follows its subtasks both ways', () => {
  it('unchecking a subtask reopens a parent that was completed by its subtasks', async () => {
    const list = await createTaskList('L');
    const task = assertDefined(await createTask(list.id, { title: 'Parent' }));
    const a = assertDefined(await createSubtask(task.id, { title: 'a' }));
    const b = assertDefined(await createSubtask(task.id, { title: 'b' }));
    await setSubtaskStatus(a.id, 'done');
    await setSubtaskStatus(b.id, 'done');
    expect((await db.tasks.get(task.id))?.status).toBe('done');

    await setSubtaskStatus(b.id, 'todo');
    const parent = await db.tasks.get(task.id);
    expect(parent?.status).toBe('todo');
    expect(parent?.completedAt).toBeUndefined();
  });
});

describe('subtask title length', () => {
  it('is capped at MAX_TITLE_LENGTH on create and on update', async () => {
    const list = await createTaskList('L');
    const task = assertDefined(await createTask(list.id, { title: 'Parent' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'x'.repeat(3000) }));
    expect((await db.subtasks.get(sub.id))?.title).toHaveLength(MAX_TITLE_LENGTH);
    await updateSubtask(sub.id, { title: 'y'.repeat(900) });
    expect((await db.subtasks.get(sub.id))?.title).toHaveLength(MAX_TITLE_LENGTH);
  });
});
