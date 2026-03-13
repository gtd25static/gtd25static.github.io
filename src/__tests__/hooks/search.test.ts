import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, deleteTask } from '../../hooks/use-tasks';
import { createSubtask, deleteSubtask } from '../../hooks/use-subtasks';
import type { SearchResult } from '../../hooks/use-search';
import type { Task, TaskList } from '../../db/models';

const MAX_SEARCH_RESULTS = 50;

/** Replicate the search logic from useSearch to test it directly against the DB */
async function searchDb(query: string): Promise<SearchResult[]> {
  if (!query || query.length < 1) return [];

  const q = query.toLowerCase();

  const lists = await db.taskLists.toArray();
  const liveLists = lists.filter((l) => !l.deletedAt);
  const listMap = new Map<string, TaskList>();
  for (const l of liveLists) listMap.set(l.id, l);

  const allTasks = await db.tasks.toArray();
  const liveTasks = allTasks.filter((t) => !t.deletedAt && listMap.has(t.listId));
  const taskMap = new Map<string, Task>();
  for (const t of liveTasks) taskMap.set(t.id, t);

  const allSubtasks = await db.subtasks.toArray();
  const liveSubtasks = allSubtasks.filter((s) => !s.deletedAt && taskMap.has(s.taskId));

  const results: SearchResult[] = [];

  for (const task of liveTasks) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    if (task.title.toLowerCase().includes(q) || task.description?.toLowerCase().includes(q)) {
      const list = listMap.get(task.listId)!;
      results.push({
        type: 'task',
        id: task.id,
        title: task.title,
        status: task.status,
        listId: task.listId,
        listName: list.name,
        listType: list.type,
        archived: task.archived,
      });
    }
  }

  for (const sub of liveSubtasks) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    if (sub.title.toLowerCase().includes(q)) {
      const task = taskMap.get(sub.taskId)!;
      const list = listMap.get(task.listId)!;
      results.push({
        type: 'subtask',
        id: sub.id,
        title: sub.title,
        status: sub.status,
        listId: task.listId,
        listName: list.name,
        listType: list.type,
        parentTaskId: task.id,
        parentTaskTitle: task.title,
      });
    }
  }

  return results;
}

let listId: string;

beforeEach(async () => {
  await resetDb();
  const list = await createTaskList('Search List');
  listId = list.id;
});

describe('search', () => {
  it('returns matching tasks by title (case-insensitive)', async () => {
    await createTask(listId, { title: 'Buy Groceries' });
    await createTask(listId, { title: 'Fix Bug' });

    const results = await searchDb('buy');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Buy Groceries');
  });

  it('returns matching tasks by description', async () => {
    await createTask(listId, { title: 'Task A', description: 'needs review from team' });

    const results = await searchDb('review');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Task A');
  });

  it('returns matching subtasks by title', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    await createSubtask(task.id, { title: 'Write unit tests' });

    const results = await searchDb('unit tests');
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('subtask');
    expect(results[0].title).toBe('Write unit tests');
  });

  it('excludes deleted tasks and subtasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Deleted Task' }));
    const task2 = assertDefined(await createTask(listId, { title: 'Parent' }));
    const sub = assertDefined(await createSubtask(task2.id, { title: 'Deleted Sub' }));

    await deleteTask(task.id);
    await deleteSubtask(sub.id);

    const results = await searchDb('Deleted');
    expect(results).toHaveLength(0);
  });

  it('excludes tasks from deleted lists', async () => {
    const deletedList = await createTaskList('Deleted List');
    await createTask(deletedList.id, { title: 'Orphan Task' });
    await db.taskLists.update(deletedList.id, { deletedAt: Date.now() });

    const results = await searchDb('Orphan');
    expect(results).toHaveLength(0);
  });

  it('caps results at 50', async () => {
    // Create 60 matching tasks
    for (let i = 0; i < 60; i++) {
      await createTask(listId, { title: `Matching item ${i}` });
    }

    const results = await searchDb('Matching');
    expect(results).toHaveLength(50);
  });

  it('returns empty for empty query', async () => {
    await createTask(listId, { title: 'Something' });

    expect(await searchDb('')).toHaveLength(0);
  });

  it('includes archived flag in results', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Archived Task' }));
    await db.tasks.update(task.id, { archived: true, updatedAt: Date.now() });

    const results = await searchDb('Archived');
    expect(results).toHaveLength(1);
    expect(results[0].archived).toBe(true);
  });

  it('includes correct listName, listType, parentTaskId for subtask results', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Parent Task' }));
    await createSubtask(task.id, { title: 'Child Sub' });

    const results = await searchDb('Child Sub');
    expect(results).toHaveLength(1);
    expect(results[0].listName).toBe('Search List');
    expect(results[0].listType).toBe('tasks');
    expect(results[0].parentTaskId).toBe(task.id);
    expect(results[0].parentTaskTitle).toBe('Parent Task');
  });
});
