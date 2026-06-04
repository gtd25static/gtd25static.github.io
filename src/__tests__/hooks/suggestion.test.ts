import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, updateTask, setTaskStatus } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';

// Replicate the mulberry32 PRNG from use-suggestion.ts to test determinism
function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Replicate the suggestion selection logic from the hook
async function getSuggestion(seed: number) {
  const taskLists = await db.taskLists.toArray();
  const taskListIds = new Set(
    taskLists.filter((l) => !l.deletedAt && l.type === 'tasks').map((l) => l.id),
  );

  const tasks = await db.tasks.toArray();
  const eligible = tasks.filter(
    (t) =>
      !t.deletedAt &&
      t.status !== 'done' &&
      t.status !== 'blocked' &&
      !t.archived &&
      taskListIds.has(t.listId),
  );

  if (eligible.length === 0) return null;

  const now = Date.now();
  const rng = mulberry32(seed);

  const weights = eligible.map((t) => {
    const ageDays = (now - t.createdAt) / (1000 * 60 * 60 * 24);
    const base = Math.sqrt(ageDays + 1);
    return t.workedAt ? base * 3 : base;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let pick = rng() * totalWeight;
  let selected = eligible[0];
  for (let i = 0; i < eligible.length; i++) {
    pick -= weights[i];
    if (pick <= 0) {
      selected = eligible[i];
      break;
    }
  }

  const result: { taskId: string; taskTitle: string; listId: string; subtaskId?: string; subtaskTitle?: string } = {
    taskId: selected.id,
    taskTitle: selected.title,
    listId: selected.listId,
  };

  const subtasks = await db.subtasks
    .where('taskId')
    .equals(selected.id)
    .sortBy('order');
  const firstTodo = subtasks.find((s) => !s.deletedAt && s.status === 'todo');
  if (firstTodo) {
    result.subtaskId = firstTodo.id;
    result.subtaskTitle = firstTodo.title;
  }

  return result;
}

let listId: string;

beforeEach(async () => {
  await resetDb();
  const list = await createTaskList('Work');
  listId = list.id;
});

describe('suggestion logic', () => {
  it('returns null when no eligible tasks exist', async () => {
    const result = await getSuggestion(42);
    expect(result).toBeNull();
  });

  it('returns a suggestion when eligible tasks exist', async () => {
    await createTask(listId, { title: 'Task A' });
    const result = await getSuggestion(42);
    expect(result).not.toBeNull();
    expect(result!.taskTitle).toBe('Task A');
    expect(result!.listId).toBe(listId);
  });

  it('excludes done tasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Done Task' }));
    await setTaskStatus(task.id, 'done');
    const result = await getSuggestion(42);
    expect(result).toBeNull();
  });

  it('excludes blocked tasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Blocked Task' }));
    await setTaskStatus(task.id, 'blocked');
    const result = await getSuggestion(42);
    expect(result).toBeNull();
  });

  it('excludes deleted tasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Deleted Task' }));
    await db.tasks.update(task.id, { deletedAt: Date.now() });
    const result = await getSuggestion(42);
    expect(result).toBeNull();
  });

  it('excludes archived tasks', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Archived' }));
    await updateTask(task.id, { archived: true });
    const result = await getSuggestion(42);
    expect(result).toBeNull();
  });

  it('excludes follow-up list tasks', async () => {
    const fuList = await createTaskList('Follow Ups', 'follow-ups');
    await createTask(fuList.id, { title: 'FU Task' });
    const result = await getSuggestion(42);
    expect(result).toBeNull();
  });

  it('is deterministic for the same seed', async () => {
    await createTask(listId, { title: 'A' });
    await createTask(listId, { title: 'B' });
    await createTask(listId, { title: 'C' });

    const r1 = await getSuggestion(123);
    const r2 = await getSuggestion(123);
    expect(r1!.taskId).toBe(r2!.taskId);
  });

  it('different seeds can produce different selections', async () => {
    // Create enough tasks to make collisions unlikely
    for (let i = 0; i < 20; i++) {
      await createTask(listId, { title: `Task ${i}` });
    }

    const results = new Set<string>();
    for (let seed = 0; seed < 50; seed++) {
      const r = await getSuggestion(seed);
      if (r) results.add(r.taskId);
    }
    // With 20 tasks and 50 seeds, we should get more than 1 unique pick
    expect(results.size).toBeGreaterThan(1);
  });

  it('includes first undone subtask in suggestion', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    const sub1 = assertDefined(await createSubtask(task.id, { title: 'Sub Done' }));
    await db.subtasks.update(sub1.id, { status: 'done' });
    const sub2 = assertDefined(await createSubtask(task.id, { title: 'Sub Todo' }));

    const result = await getSuggestion(42);
    expect(result!.subtaskId).toBe(sub2.id);
    expect(result!.subtaskTitle).toBe('Sub Todo');
  });

  it('does not include subtask when all are done', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    await db.subtasks.update(sub.id, { status: 'done' });

    const result = await getSuggestion(42);
    expect(result!.subtaskId).toBeUndefined();
  });

  it('does not include a blocked subtask as next work', async () => {
    const task = assertDefined(await createTask(listId, { title: 'Parent' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Blocked Sub' }));
    await db.subtasks.update(sub.id, { status: 'blocked' });

    const result = await getSuggestion(42);
    expect(result!.subtaskId).toBeUndefined();
  });
});

describe('mulberry32 PRNG', () => {
  it('produces values between 0 and 1', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const val = rng();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it('is deterministic', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    for (let i = 0; i < 10; i++) {
      expect(rng1()).toBe(rng2());
    }
  });
});
