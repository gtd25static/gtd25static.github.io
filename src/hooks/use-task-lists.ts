import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { TaskList, Task, Subtask, ListType } from '../db/models';
import { newId } from '../lib/id';
import { recordChangeInTx, recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { INBOX_LIST_NAME, ARCHIVED_LIST_RETENTION_MS, pickInboxList } from '../lib/constants';
import { handleDbError } from '../lib/db-error';
import { initFieldTimestamps, stampUpdatedFields } from '../sync/field-timestamps';

export function useTaskLists() {
  const allLists = useLiveQuery(
    () => db.taskLists.orderBy('order').toArray(),
    [],
  );

  return allLists?.filter((l) => !l.deletedAt) ?? [];
}

export async function createTaskList(name: string, type: ListType = 'tasks') {
  try {
    const now = Date.now();
    const id = newId();
    await ensureDeviceId();
    let list!: TaskList;
    await db.transaction('rw', [db.taskLists, db.changeLog], async () => {
      const count = await db.taskLists.count();
      list = { id, name, type, order: count, createdAt: now, updatedAt: now };
      list.fieldTimestamps = initFieldTimestamps(list as unknown as Record<string, unknown>, now);
      await db.taskLists.add(list);
      await recordChangeInTx('taskList', list.id, 'upsert', list as unknown as Record<string, unknown>);
    });
    scheduleSyncDebounced();
    return list;
  } catch (error) {
    handleDbError(error, 'create task list');
    return { id: '', name, type, order: 0, createdAt: Date.now(), updatedAt: Date.now() } as TaskList;
  }
}

export async function updateTaskList(id: string, updates: Partial<Pick<TaskList, 'name' | 'type'>>) {
  try {
    await ensureDeviceId();
    await db.transaction('rw', [db.taskLists, db.changeLog], async () => {
      const existing = await db.taskLists.get(id);
      const now = Date.now();
      const fieldTimestamps = stampUpdatedFields(existing?.fieldTimestamps, Object.keys(updates), now);
      await db.taskLists.update(id, { ...updates, updatedAt: now, fieldTimestamps });
      const updated = await db.taskLists.get(id);
      if (updated) {
        await recordChangeInTx('taskList', id, 'upsert', updated as unknown as Record<string, unknown>);
      }
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'update task list');
  }
}

/**
 * Archive / unarchive a list. Archived lists live in the collapsed section at
 * the end of the sidebar and stop feeding Focus, nudges, banners and counters;
 * `expireArchivedLists` moves them to the Trash 12 months later.
 */
export async function archiveTaskList(id: string) {
  await setArchivedAt(id, Date.now(), 'archive task list');
}

export async function unarchiveTaskList(id: string) {
  await setArchivedAt(id, undefined, 'unarchive task list');
}

async function setArchivedAt(id: string, archivedAt: number | undefined, errorContext: string) {
  try {
    await ensureDeviceId();
    await db.transaction('rw', [db.taskLists, db.changeLog], async () => {
      const existing = await db.taskLists.get(id);
      if (!existing) return;
      const now = Date.now();
      const fieldTimestamps = stampUpdatedFields(existing.fieldTimestamps, ['archivedAt'], now);
      await db.taskLists.update(id, { archivedAt, updatedAt: now, fieldTimestamps });
      const updated = await db.taskLists.get(id);
      if (updated) {
        await recordChangeInTx('taskList', id, 'upsert', updated as unknown as Record<string, unknown>);
      }
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, errorContext);
  }
}

/**
 * The `archivedAt` a list should carry after being restored from the Trash.
 * An already-expired one gets a fresh 12 months, otherwise the next startup's
 * `expireArchivedLists` would delete it again on the spot.
 */
export function archivedAtAfterRestore(archivedAt: number | undefined, now: number): number | undefined {
  if (archivedAt === undefined) return undefined;
  return archivedAt < now - ARCHIVED_LIST_RETENTION_MS ? now : archivedAt;
}

type TaskSideEntity = 'taskList' | 'task' | 'subtask';
export type TaskSideChange = { entityType: TaskSideEntity; entityId: string; operation: 'upsert' | 'delete'; data?: Record<string, unknown> };

const tableForTaskSide = { taskList: 'taskLists', task: 'tasks', subtask: 'subtasks' } as const;

/**
 * Clear deletedAt on one list, task or subtask row inside the caller's
 * transaction and return the upsert entry to record for it. Only this row —
 * cascades pick the children themselves. A list whose 12-month archive ran out
 * while it sat in the Trash gets a fresh one (see archivedAtAfterRestore).
 */
export async function undeleteRowInTx(
  entityType: TaskSideEntity,
  row: TaskList | Task | Subtask,
  now: number,
): Promise<TaskSideChange> {
  const changes: Record<string, unknown> = { deletedAt: undefined, updatedAt: now };
  const changed = ['deletedAt'];
  if (entityType === 'taskList') {
    const { archivedAt } = row as TaskList;
    const restoredArchivedAt = archivedAtAfterRestore(archivedAt, now);
    if (restoredArchivedAt !== archivedAt) {
      changes.archivedAt = restoredArchivedAt;
      changed.push('archivedAt');
    }
  }
  changes.fieldTimestamps = stampUpdatedFields(row.fieldTimestamps, changed, now);
  const table = db.table(tableForTaskSide[entityType]);
  await table.update(row.id, changes);
  const restored = await table.get(row.id);
  return { entityType, entityId: row.id, operation: 'upsert', data: restored as Record<string, unknown> };
}

/**
 * Soft-delete a list with its live tasks and their live subtasks, all stamped
 * with the list's deletedAt. Children deleted before keep their own deletedAt
 * (and get no new delete entry): that difference is how restoreTaskList tells
 * what this delete took from what was already in the Trash.
 */
/** Returns the delete's time (the cascade's deletedAt), for its Undo; undefined if nothing was deleted. */
export async function deleteTaskList(id: string): Promise<number | undefined> {
  try {
    const now = Date.now();
    const batch: TaskSideChange[] = [];
    let deleted = false;

    await ensureDeviceId();
    await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.changeLog], async () => {
      const list = await db.taskLists.get(id);
      if (!list || list.deletedAt) return;
      deleted = true;
      const listFT = stampUpdatedFields(list.fieldTimestamps, ['deletedAt'], now);
      await db.taskLists.update(id, { deletedAt: now, updatedAt: now, fieldTimestamps: listFT });
      batch.push({ entityType: 'taskList', entityId: id, operation: 'delete' });

      const tasks = await db.tasks.where('listId').equals(id).toArray();
      for (const task of tasks) {
        if (task.deletedAt) continue;
        const taskFT = stampUpdatedFields(task.fieldTimestamps, ['deletedAt'], now);
        await db.tasks.update(task.id, { deletedAt: now, updatedAt: now, fieldTimestamps: taskFT });
        batch.push({ entityType: 'task', entityId: task.id, operation: 'delete' });

        const subtasks = await db.subtasks.where('taskId').equals(task.id).toArray();
        for (const sub of subtasks) {
          if (sub.deletedAt) continue;
          const subFT = stampUpdatedFields(sub.fieldTimestamps, ['deletedAt'], now);
          await db.subtasks.update(sub.id, { deletedAt: now, updatedAt: now, fieldTimestamps: subFT });
          batch.push({ entityType: 'subtask', entityId: sub.id, operation: 'delete' });
        }
      }

      await recordChangeBatchInTx(batch);
    });

    scheduleSyncDebounced();
    return deleted ? now : undefined;
  } catch (error) {
    handleDbError(error, 'delete task list');
    return undefined;
  }
}

/**
 * Undo of deleteTaskList (toast and Trash): brings back the list plus the tasks
 * and subtasks carrying the list's exact deletedAt — the ones its delete took.
 * Anything deleted on its own before stays in the Trash. On other devices the
 * delete entries stamp deletedAt with the entry timestamp, which the whole
 * batch shares, so the equality holds there too.
 *
 * `cascadeAt` (the toast's Undo passes the delete's time): restoring one task
 * from the Trash brings its list back too, after which the Undo found a live
 * list and restored nothing else. With it, the rest of that delete comes back.
 */
export async function restoreTaskList(id: string, cascadeAt?: number) {
  try {
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.changeLog], async () => {
      const list = await db.taskLists.get(id);
      if (!list) return;
      const takenAt = list.deletedAt ?? cascadeAt;
      if (takenAt === undefined) return;
      const batch: TaskSideChange[] = list.deletedAt ? [await undeleteRowInTx('taskList', list, now)] : [];
      const tasks = await db.tasks.where('listId').equals(id).toArray();
      for (const task of tasks) {
        if (task.deletedAt !== takenAt) continue;
        batch.push(await undeleteRowInTx('task', task, now));
        const subs = await db.subtasks.where('taskId').equals(task.id).toArray();
        for (const sub of subs) {
          if (sub.deletedAt === takenAt) batch.push(await undeleteRowInTx('subtask', sub, now));
        }
      }
      await recordChangeBatchInTx(batch);
    });

    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'restore task list');
  }
}

/**
 * The full list order after dragging `activeId` onto `overId`: up lands before
 * the target, down after it. Works on ALL lists (hidden by a search filter,
 * archived, Inbox) so reorderTaskLists renumbers every list and no two share an
 * order value. Null when either id isn't a list or nothing moves.
 */
export function moveListOrder(orderedIds: string[], activeId: string, overId: string): string[] | null {
  const from = orderedIds.indexOf(activeId);
  const to = orderedIds.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...orderedIds];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export async function reorderTaskLists(orderedIds: string[]) {
  try {
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.taskLists, db.changeLog], async () => {
      for (let i = 0; i < orderedIds.length; i++) {
        const existing = await db.taskLists.get(orderedIds[i]);
        const ft = stampUpdatedFields(existing?.fieldTimestamps, ['order'], now);
        await db.taskLists.update(orderedIds[i], { order: i, updatedAt: now, fieldTimestamps: ft });
      }

      // Record upserts for all reordered lists
      const batch: Array<{ entityType: 'taskList'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
      for (const id of orderedIds) {
        const list = await db.taskLists.get(id);
        if (list) batch.push({ entityType: 'taskList', entityId: id, operation: 'upsert', data: list as unknown as Record<string, unknown> });
      }
      await recordChangeBatchInTx(batch);
    });

    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'reorder task lists');
  }
}

export async function getOrCreateInbox(): Promise<string> {
  const inbox = pickInboxList(await db.taskLists.toArray());
  if (inbox) return inbox.id;
  const list = await createTaskList(INBOX_LIST_NAME, 'tasks');
  return list.id;
}
