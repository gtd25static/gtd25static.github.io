import { db } from '../db';
import type { Task, TaskStatus } from '../db/models';
import { recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { handleDbError } from '../lib/db-error';
import { stampUpdatedFields } from '../sync/field-timestamps';

export async function deleteTasksBatch(ids: string[]) {
  if (ids.length === 0) return;
  try {
    const now = Date.now();
    const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'delete' }> = [];

    await ensureDeviceId();
    await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
      for (const id of ids) {
        await db.tasks.update(id, { deletedAt: now, updatedAt: now });
        batch.push({ entityType: 'task', entityId: id, operation: 'delete' });
        const subtasks = await db.subtasks.where('taskId').equals(id).toArray();
        for (const sub of subtasks) {
          await db.subtasks.update(sub.id, { deletedAt: now, updatedAt: now });
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

export async function moveTasksToListBatch(ids: string[], targetListId: string) {
  if (ids.length === 0) return;
  try {
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.tasks, db.changeLog], async () => {
      const existingCount = await db.tasks.where('listId').equals(targetListId).count();
      const batch: Array<{ entityType: 'task'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
      for (let i = 0; i < ids.length; i++) {
        const task = await db.tasks.get(ids[i]);
        const ft = stampUpdatedFields(task?.fieldTimestamps, ['listId', 'order'], now);
        await db.tasks.update(ids[i], { listId: targetListId, order: existingCount + i, updatedAt: now, fieldTimestamps: ft });
        const updated = await db.tasks.get(ids[i]);
        if (updated) {
          batch.push({ entityType: 'task', entityId: ids[i], operation: 'upsert', data: updated as unknown as Record<string, unknown> });
        }
      }
      await recordChangeBatchInTx(batch);
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'bulk move tasks');
  }
}
