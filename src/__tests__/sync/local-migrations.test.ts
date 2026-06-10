import { runLocalMigrations } from '../../sync/local-migrations';
import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';
import type { Task, Subtask } from '../../db/models';

describe('runLocalMigrations', () => {
  it('is a no-op when from equals to', async () => {
    // Should not throw or do anything
    await runLocalMigrations(db, 2, 2);
  });

  it('is a no-op when from equals 0 and to equals 0', async () => {
    await runLocalMigrations(db, 0, 0);
  });

  it('throws when no migration path exists', async () => {
    await expect(runLocalMigrations(db, 99, 100)).rejects.toThrow(
      'No local migration found from version 99',
    );
  });

  it('throws for non-contiguous version gap with no migrations', async () => {
    await expect(runLocalMigrations(db, 50, 55)).rejects.toThrow(
      'No local migration found from version 50',
    );
  });
});

describe('4 -> 5: legacy working-status normalization', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // The 'working' status no longer exists in the types; legacy rows are seeded
  // with a cast, exactly as a pre-v5 database would contain them.
  async function seedWorking(taskId: string, subId: string) {
    await db.tasks.update(taskId, { status: 'working' as unknown as Task['status'] });
    await db.subtasks.update(subId, { status: 'working' as unknown as Subtask['status'] });
  }

  it('normalizes working tasks/subtasks to todo, stamps timestamps, records change-log upserts', async () => {
    const list = assertDefined(await createTaskList('Tasks', 'tasks'), 'list');
    const legacy = assertDefined(await createTask(list.id, { title: 'Legacy working' }), 'legacy');
    const untouched = assertDefined(await createTask(list.id, { title: 'Plain todo' }), 'untouched');
    const legacySub = assertDefined(await createSubtask(legacy.id, { title: 'Legacy sub' }), 'legacySub');
    await seedWorking(legacy.id, legacySub.id);
    const changesBefore = await db.changeLog.count();

    await runLocalMigrations(db, 4, 5);

    const task = assertDefined(await db.tasks.get(legacy.id), 'task');
    const sub = assertDefined(await db.subtasks.get(legacySub.id), 'sub');
    expect(task.status).toBe('todo');
    expect(sub.status).toBe('todo');
    expect(task.fieldTimestamps?.status).toBe(task.updatedAt);
    expect(sub.fieldTimestamps?.status).toBe(sub.updatedAt);
    expect((await db.tasks.get(untouched.id))?.status).toBe('todo');

    const newEntries = await db.changeLog.toArray();
    expect(newEntries.length).toBe(changesBefore + 2);
    const taskEntry = newEntries.find((e) => e.entityType === 'task' && e.entityId === legacy.id && e.operation === 'upsert' && (e.data as Record<string, unknown>)?.status === 'todo');
    const subEntry = newEntries.find((e) => e.entityType === 'subtask' && e.entityId === legacySub.id && e.operation === 'upsert' && (e.data as Record<string, unknown>)?.status === 'todo');
    expect(taskEntry).toBeDefined();
    expect(subEntry).toBeDefined();
  });

  it('is a no-op when nothing carries the legacy status', async () => {
    const list = assertDefined(await createTaskList('Tasks', 'tasks'), 'list');
    await createTask(list.id, { title: 'Plain' });
    const changesBefore = await db.changeLog.count();

    await runLocalMigrations(db, 4, 5);

    expect(await db.changeLog.count()).toBe(changesBefore);
  });
});
