import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList, getOrCreateInbox } from '../../hooks/use-task-lists';
import { createTask, moveTaskToList } from '../../hooks/use-tasks';
import { isInboxList, INBOX_LIST_NAME, pickInboxList, isReservedListName } from '../../lib/constants';

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

describe('which list is the Inbox', () => {
  // Two devices that each captured something before syncing each create an
  // "Inbox"; a user could also name a list "Inbox". Only one may act as the
  // special Inbox — the others must stay reachable as ordinary lists.
  const row = (id: string, createdAt: number, extra: Record<string, unknown> = {}) =>
    ({ id, name: 'Inbox', type: 'tasks' as const, createdAt, ...extra });

  it('is the oldest live "Inbox" task list', () => {
    expect(pickInboxList([row('b', 2), row('a', 1), row('c', 3)])?.id).toBe('a');
    expect(pickInboxList([row('a', 1, { deletedAt: 5 }), row('b', 2)])?.id).toBe('b');
    expect(pickInboxList([row('a', 1, { archivedAt: 5 }), row('b', 2)])?.id).toBe('b');
    expect(pickInboxList([{ ...row('f', 0), type: 'follow-ups' as const }, row('b', 2)])?.id).toBe('b');
    expect(pickInboxList([{ id: 'w', name: 'Work', type: 'tasks' as const, createdAt: 0 }])).toBeUndefined();
  });

  it('getOrCreateInbox uses that same list', async () => {
    await db.taskLists.update(inboxListId, { createdAt: 10 });
    const older = await createTaskList(INBOX_LIST_NAME, 'tasks');
    await db.taskLists.update(older.id, { createdAt: 5 });
    expect(await getOrCreateInbox()).toBe(older.id);
  });

  it('"Inbox" is reserved for new or renamed lists, however it is typed', () => {
    expect(isReservedListName('Inbox')).toBe(true);
    expect(isReservedListName('  inbox ')).toBe(true);
    expect(isReservedListName('INBOX')).toBe(true);
    expect(isReservedListName('Inbox 2')).toBe(false);
  });
});
