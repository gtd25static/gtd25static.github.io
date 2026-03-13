import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, deleteTask, setTaskStatus } from '../../hooks/use-tasks';
import { createSubtask, deleteSubtask, setSubtaskStatus } from '../../hooks/use-subtasks';
import { DUE_SOON_DAYS } from '../../lib/constants';

interface DueSoonItem {
  type: 'task' | 'subtask';
  id: string;
  taskId: string;
  title: string;
  dueDate: number;
  parentTitle?: string;
}

/** Replicate the due-soon query logic from useDueSoon to test directly */
async function getDueSoon(): Promise<DueSoonItem[]> {
  const now = Date.now();
  const cutoff = now + DUE_SOON_DAYS * 24 * 60 * 60 * 1000;
  const result: DueSoonItem[] = [];

  const dueTasks = await db.tasks.where('dueDate').belowOrEqual(cutoff).toArray();
  for (const t of dueTasks) {
    if (t.deletedAt || t.status === 'done') continue;
    result.push({ type: 'task', id: t.id, taskId: t.id, title: t.title, dueDate: t.dueDate! });
  }

  const allSubtasks = await db.subtasks.toArray();
  const parentIds = new Set<string>();
  const dueSubs: typeof allSubtasks = [];
  for (const s of allSubtasks) {
    if (s.deletedAt || s.status === 'done') continue;
    if (s.dueDate && s.dueDate <= cutoff) {
      dueSubs.push(s);
      parentIds.add(s.taskId);
    }
  }

  if (dueSubs.length > 0) {
    const parents = await db.tasks.bulkGet([...parentIds]);
    const parentMap = new Map(parents.filter(Boolean).map((p) => [p!.id, p!]));
    for (const s of dueSubs) {
      const parent = parentMap.get(s.taskId);
      result.push({
        type: 'subtask',
        id: s.id,
        taskId: s.taskId,
        title: s.title,
        dueDate: s.dueDate!,
        parentTitle: parent?.title,
      });
    }
  }

  result.sort((a, b) => a.dueDate - b.dueDate);
  return result;
}

let listId: string;

beforeEach(async () => {
  await resetDb();
  const list = await createTaskList('Due Soon List');
  listId = list.id;
});

describe('due-soon', () => {
  it('returns tasks with dueDate <= cutoff', async () => {
    const soon = Date.now() + 1 * 24 * 60 * 60 * 1000; // 1 day from now
    const task = assertDefined(await createTask(listId, { title: 'Due Soon', dueDate: soon }));

    const results = await getDueSoon();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(task.id);
    expect(results[0].type).toBe('task');
  });

  it('returns subtasks with dueDate <= cutoff', async () => {
    const soon = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Due Sub', dueDate: soon }));

    const results = await getDueSoon();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(sub.id);
    expect(results[0].type).toBe('subtask');
  });

  it('excludes deleted items', async () => {
    const soon = Date.now() + 1 * 24 * 60 * 60 * 1000;
    const task = assertDefined(await createTask(listId, { title: 'Deleted Due', dueDate: soon }));
    await deleteTask(task.id);

    const task2 = assertDefined(await createTask(listId, { title: 'Parent2' }));
    const sub = assertDefined(await createSubtask(task2.id, { title: 'Deleted Sub', dueDate: soon }));
    await deleteSubtask(sub.id);

    const results = await getDueSoon();
    expect(results).toHaveLength(0);
  });

  it('excludes done items', async () => {
    const soon = Date.now() + 1 * 24 * 60 * 60 * 1000;
    const task = assertDefined(await createTask(listId, { title: 'Done Due', dueDate: soon }));
    await setTaskStatus(task.id, 'done');

    const task2 = assertDefined(await createTask(listId, { title: 'Parent3' }));
    const sub = assertDefined(await createSubtask(task2.id, { title: 'Done Sub', dueDate: soon }));
    await setSubtaskStatus(sub.id, 'done');

    const results = await getDueSoon();
    expect(results).toHaveLength(0);
  });

  it('sorts by dueDate ascending', async () => {
    const later = Date.now() + 5 * 24 * 60 * 60 * 1000;
    const sooner = Date.now() + 1 * 24 * 60 * 60 * 1000;
    await createTask(listId, { title: 'Later', dueDate: later });
    await createTask(listId, { title: 'Sooner', dueDate: sooner });

    const results = await getDueSoon();
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Sooner');
    expect(results[1].title).toBe('Later');
  });

  it('includes parent task title for subtask results', async () => {
    const soon = Date.now() + 1 * 24 * 60 * 60 * 1000;
    const task = assertDefined(await createTask(listId, { title: 'My Parent' }));
    await createSubtask(task.id, { title: 'My Sub', dueDate: soon });

    const results = await getDueSoon();
    expect(results).toHaveLength(1);
    expect(results[0].parentTitle).toBe('My Parent');
  });

  it('returns empty when nothing is due', async () => {
    const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
    await createTask(listId, { title: 'Far Away', dueDate: farFuture });

    const results = await getDueSoon();
    expect(results).toHaveLength(0);
  });
});
