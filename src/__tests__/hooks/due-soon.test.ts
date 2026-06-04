import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, deleteTask, setTaskStatus, updateTask } from '../../hooks/use-tasks';
import { createSubtask, deleteSubtask, setSubtaskStatus } from '../../hooks/use-subtasks';
import { getDueSoonItems } from '../../hooks/use-due-soon';

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

    const results = await getDueSoonItems();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(task.id);
    expect(results[0].type).toBe('task');
  });

  it('returns subtasks with dueDate <= cutoff', async () => {
    const soon = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Due Sub', dueDate: soon }));

    const results = await getDueSoonItems();
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

    const results = await getDueSoonItems();
    expect(results).toHaveLength(0);
  });

  it('excludes done items', async () => {
    const soon = Date.now() + 1 * 24 * 60 * 60 * 1000;
    const task = assertDefined(await createTask(listId, { title: 'Done Due', dueDate: soon }));
    await setTaskStatus(task.id, 'done');

    const task2 = assertDefined(await createTask(listId, { title: 'Parent3' }));
    const sub = assertDefined(await createSubtask(task2.id, { title: 'Done Sub', dueDate: soon }));
    await setSubtaskStatus(sub.id, 'done');

    const results = await getDueSoonItems();
    expect(results).toHaveLength(0);
  });

  it('sorts by dueDate ascending', async () => {
    const later = Date.now() + 5 * 24 * 60 * 60 * 1000;
    const sooner = Date.now() + 1 * 24 * 60 * 60 * 1000;
    await createTask(listId, { title: 'Later', dueDate: later });
    await createTask(listId, { title: 'Sooner', dueDate: sooner });

    const results = await getDueSoonItems();
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Sooner');
    expect(results[1].title).toBe('Later');
  });

  it('includes parent task title for subtask results', async () => {
    const soon = Date.now() + 1 * 24 * 60 * 60 * 1000;
    const task = assertDefined(await createTask(listId, { title: 'My Parent' }));
    await createSubtask(task.id, { title: 'My Sub', dueDate: soon });

    const results = await getDueSoonItems();
    expect(results).toHaveLength(1);
    expect(results[0].parentTitle).toBe('My Parent');
  });

  it('returns empty when nothing is due', async () => {
    const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
    await createTask(listId, { title: 'Far Away', dueDate: farFuture });

    const results = await getDueSoonItems();
    expect(results).toHaveLength(0);
  });

  it('excludes archived tasks and subtasks under inactive parents', async () => {
    const soon = Date.now() + 1 * 24 * 60 * 60 * 1000;
    const archived = assertDefined(await createTask(listId, { title: 'Archived', dueDate: soon }));
    await updateTask(archived.id, { archived: true });

    const doneParent = assertDefined(await createTask(listId, { title: 'Done Parent' }));
    await setTaskStatus(doneParent.id, 'done');
    await createSubtask(doneParent.id, { title: 'Sub under done', dueDate: soon });

    const archivedParent = assertDefined(await createTask(listId, { title: 'Archived Parent' }));
    await updateTask(archivedParent.id, { archived: true });
    await createSubtask(archivedParent.id, { title: 'Sub under archived', dueDate: soon });

    const results = await getDueSoonItems();
    expect(results).toHaveLength(0);
  });
});
