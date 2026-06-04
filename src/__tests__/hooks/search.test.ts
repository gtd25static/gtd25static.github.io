import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, deleteTask } from '../../hooks/use-tasks';
import { createSubtask, deleteSubtask } from '../../hooks/use-subtasks';
import { searchDb } from '../../hooks/use-search';

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

  it('returns matching lists', async () => {
    const results = await searchDb('search list');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({
      type: 'list',
      title: 'Search List',
      listId,
      listType: 'tasks',
    }));
  });

  it('returns matching follow-up items', async () => {
    const followUpList = await createTaskList('People', 'follow-ups');
    await createTask(followUpList.id, { title: 'Follow up with Rosa' });

    const results = await searchDb('rosa');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({
      type: 'task',
      title: 'Follow up with Rosa',
      listType: 'follow-ups',
    }));
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

  it('includes archived follow-up items in results', async () => {
    const followUpList = await createTaskList('People', 'follow-ups');
    const task = assertDefined(await createTask(followUpList.id, { title: 'Archived follow-up' }));
    await db.tasks.update(task.id, { archived: true, updatedAt: Date.now() });

    const results = await searchDb('archived follow');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({
      type: 'task',
      listType: 'follow-ups',
      archived: true,
    }));
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
    expect(results[0].parentTaskStatus).toBe('todo');
  });
});
