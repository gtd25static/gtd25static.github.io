import { db } from '../db';
import type { Task, TaskStatus } from '../db/models';
import { recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { handleDbError } from '../lib/db-error';
import { stampUpdatedFields } from '../sync/field-timestamps';
import { crossTypeUpdates } from './use-tasks';

export async function deleteTasksBatch(ids: string[]) {
  if (ids.length === 0) return;
  try {
    const now = Date.now();
    const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'delete' }> = [];

    await ensureDeviceId();
    await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
      for (const id of ids) {
        const task = await db.tasks.get(id);
        const taskFT = stampUpdatedFields(task?.fieldTimestamps, ['deletedAt'], now);
        await db.tasks.update(id, { deletedAt: now, updatedAt: now, fieldTimestamps: taskFT });
        batch.push({ entityType: 'task', entityId: id, operation: 'delete' });
        const subtasks = await db.subtasks.where('taskId').equals(id).toArray();
        for (const sub of subtasks) {
          const subFT = stampUpdatedFields(sub.fieldTimestamps, ['deletedAt'], now);
          await db.subtasks.update(sub.id, { deletedAt: now, updatedAt: now, fieldTimestamps: subFT });
          batch.push({ entityType: 'subtask', entityId: sub.id, operation: 'delete' });
        }
      }
      await recordChangeBatchInTx(batch);
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'bulk delete tasks');
  }
}

export async function setTaskStatusBatch(ids: string[], status: TaskStatus) {
  if (ids.length === 0) return;
  try {
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.tasks, db.changeLog], async () => {
      const batch: Array<{ entityType: 'task'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
      for (const id of ids) {
        const task = await db.tasks.get(id);
        if (!task) continue;
        const updates: Partial<Task> = { status, updatedAt: now };
        if (status === 'blocked' && task.status !== 'blocked') {
          updates.blockedAt = now;
        } else if (status !== 'blocked' && task.status === 'blocked') {
          updates.blockedAt = undefined;
        }
        if (status === 'done') {
          updates.completedAt = now;
        } else if (task.status === 'done') {
          updates.completedAt = undefined;
        }
        updates.fieldTimestamps = stampUpdatedFields(task.fieldTimestamps, Object.keys(updates), now);
        await db.tasks.update(id, updates);
        const updated = await db.tasks.get(id);
        if (updated) {
          batch.push({ entityType: 'task', entityId: id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
        }
      }
      await recordChangeBatchInTx(batch);
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'bulk set task status');
  }
}

/**
 * Move tasks to the end of another list, with the same cross-type translation
 * as moveTaskToList. Tasks with subtasks headed for a follow-up list are left
 * where they are and counted as `skipped` (follow-up cards don't show subtasks).
 */
export async function moveTasksToListBatch(ids: string[], targetListId: string): Promise<{ moved: number; skipped: number }> {
  const none = { moved: 0, skipped: 0 };
  if (ids.length === 0) return none;
  try {
    const targetList = await db.taskLists.get(targetListId);
    if (!targetList) return none;
    const listTypes = new Map((await db.taskLists.toArray()).map((l) => [l.id, l.type]));
    const tasks = (await db.tasks.bulkGet(ids)).filter((t): t is Task => !!t);
    const crosses = (t: Task) => {
      const sourceType = listTypes.get(t.listId);
      return !!sourceType && sourceType !== targetList.type;
    };
    const blocked = new Set<string>();
    if (targetList.type === 'follow-ups') {
      const crossing = tasks.filter(crosses).map((t) => t.id);
      const subtasks = crossing.length > 0 ? await db.subtasks.where('taskId').anyOf(crossing).toArray() : [];
      for (const s of subtasks) if (!s.deletedAt) blocked.add(s.taskId);
    }
    const toMove = tasks.filter((t) => !blocked.has(t.id)).map((t) => t.id);

    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.tasks, db.changeLog], async () => {
      const existingCount = await db.tasks.where('listId').equals(targetListId).count();
      const batch: Array<{ entityType: 'task'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
      for (let i = 0; i < toMove.length; i++) {
        const task = await db.tasks.get(toMove[i]);
        if (!task) continue;
        const translated = crosses(task) ? crossTypeUpdates(task, targetList.type, now) : {};
        const ft = stampUpdatedFields(task.fieldTimestamps, ['listId', 'order', ...Object.keys(translated)], now);
        await db.tasks.update(toMove[i], { ...translated, listId: targetListId, order: existingCount + i, updatedAt: now, fieldTimestamps: ft });
        const updated = await db.tasks.get(toMove[i]);
        if (updated) {
          batch.push({ entityType: 'task', entityId: toMove[i], operation: 'upsert', data: updated as unknown as Record<string, unknown> });
        }
      }
      await recordChangeBatchInTx(batch);
    });
    scheduleSyncDebounced();
    return { moved: toMove.length, skipped: blocked.size };
  } catch (error) {
    handleDbError(error, 'bulk move tasks');
    return none;
  }
}
