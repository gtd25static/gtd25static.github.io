import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import {
  createTaskList,
  archiveTaskList,
  unarchiveTaskList,
  archivedAtAfterRestore,
  restoreTaskList,
  deleteTaskList,
  getOrCreateInbox,
} from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { createSubtask } from '../../hooks/use-subtasks';
import { expireArchivedLists } from '../../db/purge';
import { taskListIds } from '../../lib/attention';
import { ARCHIVED_LIST_RETENTION_MS } from '../../lib/constants';
import type { TaskList } from '../../db/models';
import { seedListWithEarlierDeletes } from '../helpers/cascade-fixtures';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDb();
});

describe('archiveTaskList / unarchiveTaskList', () => {
  it('stamps and clears archivedAt', async () => {
    const list = await createTaskList('Old project');

    await archiveTaskList(list.id);
    const archived = assertDefined(await db.taskLists.get(list.id));
    expect(archived.archivedAt).toBeGreaterThan(0);
    expect(archived.deletedAt).toBeUndefined();

    await unarchiveTaskList(list.id);
    const back = assertDefined(await db.taskLists.get(list.id));
    expect(back.archivedAt).toBeUndefined();
  });

  it('works on follow-up lists too', async () => {
    const list = await createTaskList('People', 'follow-ups');
    await archiveTaskList(list.id);
    expect((await db.taskLists.get(list.id))?.archivedAt).toBeGreaterThan(0);
  });

  it('records a changelog upsert and a field timestamp so the change syncs', async () => {
    const list = await createTaskList('Old project');
    await db.changeLog.clear();

    await archiveTaskList(list.id);

    const entries = await db.changeLog.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0].entityType).toBe('taskList');
    expect(entries[0].operation).toBe('upsert');
    expect((entries[0].data as unknown as TaskList).archivedAt).toBeGreaterThan(0);

    const stored = assertDefined(await db.taskLists.get(list.id));
    expect(stored.fieldTimestamps?.archivedAt).toBeGreaterThan(0);
  });

  it('leaves the list and its tasks alive and visible to the list view', async () => {
    const list = await createTaskList('Old project');
    const task = assertDefined(await createTask(list.id, { title: 'Still here' }));

    await archiveTaskList(list.id);

    expect((await db.tasks.get(task.id))?.deletedAt).toBeUndefined();
    const lists = await db.taskLists.toArray();
    expect(lists.filter((l) => !l.deletedAt).map((l) => l.id)).toContain(list.id);
  });

  it('is a no-op on an unknown id', async () => {
    await archiveTaskList('does-not-exist');
    expect(await db.taskLists.get('does-not-exist')).toBeUndefined();
  });
});

describe('taskListIds', () => {
  it('excludes archived lists so they stop feeding Focus, nudges and banners', () => {
    const base = { type: 'tasks' as const, order: 0, createdAt: 1, updatedAt: 1 };
    const lists: TaskList[] = [
      { id: 'active', name: 'Active', ...base },
      { id: 'archived', name: 'Archived', ...base, archivedAt: 1000 },
      { id: 'deleted', name: 'Deleted', ...base, deletedAt: 1000 },
    ];
    expect([...taskListIds(lists)]).toEqual(['active']);
  });
});

describe('expireArchivedLists', () => {
  it('moves lists archived over 12 months ago to the trash, cascading to children', async () => {
    const now = Date.now();
    const list = await createTaskList('Ancient');
    const task = assertDefined(await createTask(list.id, { title: 'Task' }));
    const sub = assertDefined(await createSubtask(task.id, { title: 'Sub' }));
    await db.taskLists.update(list.id, { archivedAt: now - ARCHIVED_LIST_RETENTION_MS - DAY });

    await expireArchivedLists(now);

    expect((await db.taskLists.get(list.id))?.deletedAt).toBeGreaterThan(0);
    expect((await db.tasks.get(task.id))?.deletedAt).toBeGreaterThan(0);
    expect((await db.subtasks.get(sub.id))?.deletedAt).toBeGreaterThan(0);
  });

  it('leaves children deleted earlier out of the expiry, so restoring the list does not bring them back', async () => {
    const now = Date.now();
    const s = await seedListWithEarlierDeletes();
    await db.taskLists.update(s.list.id, { archivedAt: now - ARCHIVED_LIST_RETENTION_MS - DAY });

    await expireArchivedLists(now);
    expect((await db.tasks.get(s.gone.id))?.deletedAt).toBe(s.earlier.gone);
    expect((await db.subtasks.get(s.goneSub.id))?.deletedAt).toBe(s.earlier.goneSub);

    await restoreTaskList(s.list.id);
    expect((await db.tasks.get(s.keep.id))?.deletedAt).toBeUndefined();
    expect((await db.subtasks.get(s.keepSub.id))?.deletedAt).toBeUndefined();
    expect((await db.tasks.get(s.gone.id))?.deletedAt).toBe(s.earlier.gone);
    expect((await db.subtasks.get(s.goneChild.id))?.deletedAt).toBe(s.earlier.goneChild);
    expect((await db.subtasks.get(s.goneSub.id))?.deletedAt).toBe(s.earlier.goneSub);
  });

  it('records the deletion in the changelog so other devices drop it too', async () => {
    const now = Date.now();
    const list = await createTaskList('Ancient');
    await db.taskLists.update(list.id, { archivedAt: now - ARCHIVED_LIST_RETENTION_MS - DAY });
    await db.changeLog.clear();

    await expireArchivedLists(now);

    const entries = await db.changeLog.toArray();
    expect(entries.some((e) => e.entityType === 'taskList' && e.entityId === list.id && e.operation === 'delete')).toBe(true);
  });

  it('keeps lists archived less than 12 months ago', async () => {
    const now = Date.now();
    const list = await createTaskList('Recent');
    await db.taskLists.update(list.id, { archivedAt: now - ARCHIVED_LIST_RETENTION_MS + DAY });

    await expireArchivedLists(now);

    expect((await db.taskLists.get(list.id))?.deletedAt).toBeUndefined();
  });

  it('never touches lists that were never archived', async () => {
    const list = await createTaskList('Active');

    await expireArchivedLists(Date.now());

    expect((await db.taskLists.get(list.id))?.deletedAt).toBeUndefined();
  });

  it('leaves an already-deleted list alone (the 30-day trash purge owns it)', async () => {
    const now = Date.now();
    const list = await createTaskList('Gone');
    await archiveTaskList(list.id);
    await deleteTaskList(list.id);
    const deletedAt = assertDefined((await db.taskLists.get(list.id))?.deletedAt);
    await db.taskLists.update(list.id, { archivedAt: now - ARCHIVED_LIST_RETENTION_MS - DAY });

    await expireArchivedLists(now);

    expect((await db.taskLists.get(list.id))?.deletedAt).toBe(deletedAt);
  });
});

describe('archivedAtAfterRestore', () => {
  const now = 1_000_000_000_000;

  it('keeps the original date for a list that has not expired', () => {
    const archivedAt = now - DAY;
    expect(archivedAtAfterRestore(archivedAt, now)).toBe(archivedAt);
  });

  it('gives an expired list a fresh 12 months', () => {
    expect(archivedAtAfterRestore(now - ARCHIVED_LIST_RETENTION_MS - DAY, now)).toBe(now);
  });

  it('leaves a never-archived list unarchived', () => {
    expect(archivedAtAfterRestore(undefined, now)).toBeUndefined();
  });
});

describe('restoreTaskList on an archived list', () => {
  it('restarts the clock so the next startup does not delete it again', async () => {
    const now = Date.now();
    const list = await createTaskList('Ancient');
    await db.taskLists.update(list.id, { archivedAt: now - ARCHIVED_LIST_RETENTION_MS - DAY });
    await expireArchivedLists(now);

    await restoreTaskList(list.id);
    const restored = assertDefined(await db.taskLists.get(list.id));
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.archivedAt).toBeGreaterThan(now - ARCHIVED_LIST_RETENTION_MS);

    await expireArchivedLists(Date.now());
    expect((await db.taskLists.get(list.id))?.deletedAt).toBeUndefined();
  });
});

describe('getOrCreateInbox', () => {
  it('never captures into an archived Inbox — it creates a fresh one', async () => {
    const stale = await createTaskList('Inbox');
    await archiveTaskList(stale.id);

    const inboxId = await getOrCreateInbox();

    expect(inboxId).not.toBe(stale.id);
    expect((await db.taskLists.get(inboxId))?.archivedAt).toBeUndefined();
  });
});
