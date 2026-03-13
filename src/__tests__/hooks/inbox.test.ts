import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, moveTaskToList } from '../../hooks/use-tasks';
import { isInboxList, INBOX_LIST_NAME } from '../../lib/constants';

let inboxListId: string;
let taskListId: string;
let followUpListId: string;

beforeEach(async () => {
  await resetDb();
  const inbox = await createTaskList(INBOX_LIST_NAME, 'tasks');
  inboxListId = inbox.id;
  const taskList = await createTaskList('Work');
  taskListId = taskList.id;
  const followUpList = await createTaskList('Waiting On', 'follow-ups');
  followUpListId = followUpList.id;
});

describe('isInboxList', () => {
  it('identifies inbox list correctly', () => {
    expect(isInboxList({ name: 'Inbox', type: 'tasks' })).toBe(true);
  });

  it('rejects non-inbox task list', () => {
    expect(isInboxList({ name: 'Work', type: 'tasks' })).toBe(false);
  });

  it('rejects follow-up list named Inbox', () => {
    expect(isInboxList({ name: 'Inbox', type: 'follow-ups' })).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isInboxList({ name: 'inbox', type: 'tasks' })).toBe(false);
    expect(isInboxList({ name: 'INBOX', type: 'tasks' })).toBe(false);
  });
});

describe('moveTaskToList from inbox', () => {
  it('moves task from inbox to a task list', async () => {
    const task = assertDefined(await createTask(inboxListId, { title: 'Process me' }));
    expect(task.listId).toBe(inboxListId);

    await moveTaskToList(task.id, taskListId);

    const moved = await db.tasks.get(task.id);
    expect(moved?.listId).toBe(taskListId);
  });

  it('moves task from inbox to a follow-up list', async () => {
    const task = assertDefined(await createTask(inboxListId, { title: 'Follow up on this' }));
    expect(task.listId).toBe(inboxListId);

    await moveTaskToList(task.id, followUpListId);

    const moved = await db.tasks.get(task.id);
    expect(moved?.listId).toBe(followUpListId);
  });

  it('sets order correctly when moving to a list with existing tasks', async () => {
    // Create existing tasks in the target list
    await createTask(taskListId, { title: 'Existing 1' });
    await createTask(taskListId, { title: 'Existing 2' });

    const inboxTask = assertDefined(await createTask(inboxListId, { title: 'From inbox' }));
    await moveTaskToList(inboxTask.id, taskListId);

    const moved = await db.tasks.get(inboxTask.id);
    // Should be appended at end (order = 2, since 2 existing tasks)
    expect(moved?.order).toBe(2);
  });

  it('records change in changelog after move', async () => {
    const task = assertDefined(await createTask(inboxListId, { title: 'Track me' }));
    const countBefore = await db.changeLog.count();

    await moveTaskToList(task.id, taskListId);

    const countAfter = await db.changeLog.count();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});
