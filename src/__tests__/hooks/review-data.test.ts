import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, setTaskStatus } from '../../hooks/use-tasks';
import { createSubtask, setSubtaskStatus } from '../../hooks/use-subtasks';
import { setLastReviewedAt } from '../../hooks/use-review-data';
import { INBOX_LIST_NAME } from '../../lib/constants';

// Since useReviewData is a hook (useLiveQuery), we test the underlying data logic directly
// by querying the db the same way the hook does

let inboxId: string;
let listId: string;

beforeEach(async () => {
  await resetDb();
  const inbox = await createTaskList(INBOX_LIST_NAME, 'tasks');
  inboxId = inbox.id;
  const list = await createTaskList('Work');
  listId = list.id;
});

async function getReviewSnapshot() {
  const now = Date.now();
  const staleThreshold = now - 7 * 24 * 60 * 60 * 1000;
  const weekStart = getStartOfWeek();

  const allLists = await db.taskLists.orderBy('order').toArray();
  const allTasks = await db.tasks.toArray();
  const allSubtasks = await db.subtasks.toArray();

  const liveLists = allLists.filter((l) => !l.deletedAt);
  const liveTasks = allTasks.filter((t) => !t.deletedAt);
  const liveSubtasks = allSubtasks.filter((s) => !s.deletedAt);

  const inboxList = liveLists.find((l) => l.name === INBOX_LIST_NAME && l.type === 'tasks');
  const inboxTasks = inboxList
    ? liveTasks.filter((t) => t.listId === inboxList.id && t.status !== 'done')
    : [];

  const taskLists = liveLists.filter((l) => l.type === 'tasks' && l.name !== INBOX_LIST_NAME);
  const listsWithTasks = taskLists.map((list) => {
    const tasks = liveTasks.filter((t) => t.listId === list.id && t.status !== 'done');
    const staleCount = tasks.filter((t) => t.updatedAt < staleThreshold).length;
    return { list, tasks, staleCount };
  }).filter((e) => e.tasks.length > 0);

  const blockedTasks = liveTasks.filter((t) => t.status === 'blocked' && !t.archived);
  const blockedSubtasks = liveSubtasks.filter((s) => s.status === 'blocked');

  let completedThisWeek = 0;
  let addedThisWeek = 0;
  for (const t of liveTasks) {
    if (t.status === 'done' && !t.archived) {
      const completedAt = t.completedAt ?? t.updatedAt;
      if (completedAt >= weekStart) completedThisWeek++;
    }
    if (t.createdAt >= weekStart) addedThisWeek++;
  }

  return { inboxTasks, listsWithTasks, blockedTasks, blockedSubtasks, completedThisWeek, addedThisWeek };
}

function getStartOfWeek(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay() || 7; // treat Sunday (0) as 7
  d.setDate(d.getDate() - day + 1);
  return d.getTime();
}

describe('review data - inbox', () => {
  it('finds inbox tasks', async () => {
    await createTask(inboxId, { title: 'Inbox 1' });
    await createTask(inboxId, { title: 'Inbox 2' });
    const snap = await getReviewSnapshot();
    expect(snap.inboxTasks.length).toBe(2);
  });

  it('excludes done inbox tasks', async () => {
    const task = assertDefined(await createTask(inboxId, { title: 'Done' }));
    await setTaskStatus(task.id, 'done');
    const snap = await getReviewSnapshot();
    expect(snap.inboxTasks.length).toBe(0);
  });
});

describe('review data - lists', () => {
  it('groups tasks by list', async () => {
    await createTask(listId, { title: 'Task 1' });
    await createTask(listId, { title: 'Task 2' });
    const snap = await getReviewSnapshot();
    expect(snap.listsWithTasks.length).toBe(1);
    expect(snap.listsWithTasks[0].tasks.length).toBe(2);
  });

  it('excludes inbox from list review', async () => {
    await createTask(inboxId, { title: 'Inbox item' });
    const snap = await getReviewSnapshot();
    // Inbox should not appear in listsWithTasks
    expect(snap.listsWithTasks.every((e) => e.list.name !== INBOX_LIST_NAME)).toBe(true);
  });

  it('identifies stale tasks (>7 days)', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Old task' }));
    // Manually backdate updatedAt
    const staleTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await db.tasks.update(task.id, { updatedAt: staleTime });
    const snap = await getReviewSnapshot();
    expect(snap.listsWithTasks[0].staleCount).toBe(1);
  });
});

describe('review data - blocked', () => {
  it('finds blocked tasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Blocked' }));
    await setTaskStatus(task.id, 'blocked');
    const snap = await getReviewSnapshot();
    expect(snap.blockedTasks.length).toBe(1);
  });

  it('finds blocked subtasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    await setSubtaskStatus(sub.id, 'blocked');
    const snap = await getReviewSnapshot();
    expect(snap.blockedSubtasks.length).toBe(1);
  });
});

describe('review data - stats', () => {
  it('counts completions this week', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Done' }));
    await setTaskStatus(task.id, 'done');
    const snap = await getReviewSnapshot();
    expect(snap.completedThisWeek).toBeGreaterThanOrEqual(1);
  });

  it('counts tasks added this week', async () => {
    await createTask(listId, { title: 'New' });
    const snap = await getReviewSnapshot();
    // Should count inbox + list tasks created this week
    expect(snap.addedThisWeek).toBeGreaterThanOrEqual(1);
  });
});

describe('setLastReviewedAt', () => {
  it('persists lastReviewedAt timestamp', async () => {
    await setLastReviewedAt();
    const local = await db.localSettings.get('local');
    const record = local as unknown as Record<string, unknown>;
    expect(record?.lastReviewedAt).toBeDefined();
    expect(typeof record?.lastReviewedAt).toBe('number');
  });
});
