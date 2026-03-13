import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, setTaskStatus, updateTask } from '../../hooks/use-tasks';
import { createSubtask, setSubtaskStatus } from '../../hooks/use-subtasks';

interface BlockedItem {
  id: string;
  listId: string;
  title: string;
  reason: 'task' | 'subtask';
  blockedSubtaskCount?: number;
}

/** Replicate the blocked query logic from useBlocked to test directly */
async function getBlocked(): Promise<BlockedItem[]> {
  const result: BlockedItem[] = [];

  const [blockedTasks, blockedSubs] = await Promise.all([
    db.tasks.where('status').equals('blocked').toArray(),
    db.subtasks.where('status').equals('blocked').toArray(),
  ]);

  for (const t of blockedTasks) {
    if (t.deletedAt || t.status === 'done' || t.archived) continue;
    result.push({ id: t.id, listId: t.listId, title: t.title, reason: 'task' });
  }

  const blockedByTask = new Map<string, number>();
  for (const s of blockedSubs) {
    if (s.deletedAt) continue;
    blockedByTask.set(s.taskId, (blockedByTask.get(s.taskId) || 0) + 1);
  }

  const directlyBlocked = new Set(blockedTasks.map((t) => t.id));
  const parentIds = [...blockedByTask.keys()].filter((id) => !directlyBlocked.has(id));
  if (parentIds.length > 0) {
    const parents = await db.tasks.bulkGet(parentIds);
    for (const parent of parents) {
      if (!parent || parent.deletedAt || parent.status === 'done' || parent.archived) continue;
      const count = blockedByTask.get(parent.id)!;
      result.push({ id: parent.id, listId: parent.listId, title: parent.title, reason: 'subtask', blockedSubtaskCount: count });
    }
  }

  return result;
}

let listId: string;

beforeEach(async () => {
  await resetDb();
  const list = await createTaskList('Blocked List');
  listId = list.id;
});

describe('blocked', () => {
  it('returns directly blocked tasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Blocked Task' }));
    await setTaskStatus(task.id, 'blocked');

    const results = await getBlocked();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(task.id);
    expect(results[0].reason).toBe('task');
  });

  it('returns tasks with blocked subtasks (with count)', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    const sub1 = assertDefined(await createSubtask(task.id, { title: 'Sub1' }));
    const sub2 = assertDefined(await createSubtask(task.id, { title: 'Sub2' }));
    await setSubtaskStatus(sub1.id, 'blocked');
    await setSubtaskStatus(sub2.id, 'blocked');

    const results = await getBlocked();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(task.id);
    expect(results[0].reason).toBe('subtask');
    expect(results[0].blockedSubtaskCount).toBe(2);
  });

  it('excludes deleted tasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Deleted Blocked' }));
    await setTaskStatus(task.id, 'blocked');
    await db.tasks.update(task.id, { deletedAt: Date.now() });

    const results = await getBlocked();
    expect(results).toHaveLength(0);
  });

  it('excludes archived tasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Archived Blocked' }));
    await setTaskStatus(task.id, 'blocked');
    await updateTask(task.id, { archived: true });

    const results = await getBlocked();
    expect(results).toHaveLength(0);
  });

  it('excludes done tasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Done Blocked' }));
    // Set blocked then done — status field will be 'done' but we need to test the filter
    await db.tasks.update(task.id, { status: 'done', updatedAt: Date.now() });

    const results = await getBlocked();
    expect(results).toHaveLength(0);
  });

  it('does not double-count tasks that are both directly blocked and have blocked subtasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Double Block' }));
    await setTaskStatus(task.id, 'blocked');
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    await setSubtaskStatus(sub.id, 'blocked');

    const results = await getBlocked();
    // Should appear only once (as directly blocked task)
    expect(results).toHaveLength(1);
    expect(results[0].reason).toBe('task');
  });
});
