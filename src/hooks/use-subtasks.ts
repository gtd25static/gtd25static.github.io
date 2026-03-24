import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Subtask, SubtaskStatus, TaskLink } from '../db/models';
import { newId } from '../lib/id';
import { recordChangeInTx, recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { computeNextOccurrence } from './use-recurring';
import { handleDbError } from '../lib/db-error';
import { initFieldTimestamps, stampUpdatedFields } from '../sync/field-timestamps';

export function useSubtasks(taskId: string | undefined) {
  return useLiveQuery(
    async () => {
      if (!taskId) return [];
      const all = await db.subtasks.where('taskId').equals(taskId).sortBy('order');
      return all.filter((s) => !s.deletedAt);
    },
    [taskId],
    [],
  );
}

export async function createSubtask(
  taskId: string,
  data: { title: string; link?: string; linkTitle?: string; dueDate?: number },
) {
  try {
    const now = Date.now();
    const id = newId();
    await ensureDeviceId();
    let subtask!: Subtask;
    await db.transaction('rw', [db.subtasks, db.changeLog], async () => {
      const count = await db.subtasks.where('taskId').equals(taskId).count();
      subtask = {
        id,
        taskId,
        title: data.title,
        link: data.link,
        linkTitle: data.linkTitle,
        dueDate: data.dueDate,
        status: 'todo',
        order: count,
        createdAt: now,
        updatedAt: now,
      };
      subtask.fieldTimestamps = initFieldTimestamps(subtask as unknown as Record<string, unknown>, now);
      await db.subtasks.add(subtask);
      await recordChangeInTx('subtask', subtask.id, 'upsert', subtask as unknown as Record<string, unknown>);
    });
    scheduleSyncDebounced();
    return subtask;
  } catch (error) {
    handleDbError(error, 'create subtask');
    return undefined;
  }
}

export async function updateSubtask(id: string, updates: Partial<Subtask>) {
  try {
    await ensureDeviceId();
    await db.transaction('rw', [db.subtasks, db.changeLog], async () => {
      const existing = await db.subtasks.get(id);
      const now = Date.now();
      const fieldTimestamps = stampUpdatedFields(
        existing?.fieldTimestamps,
        Object.keys(updates),
        now,
      );
      await db.subtasks.update(id, { ...updates, updatedAt: now, fieldTimestamps });
      const updated = await db.subtasks.get(id);
      if (updated) {
        await recordChangeInTx('subtask', id, 'upsert', updated as unknown as Record<string, unknown>);
      }
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'update subtask');
  }
}

export async function setSubtaskStatus(id: string, status: SubtaskStatus) {
  try {
    if (status === 'working') {
      const allWorkingSubs = await db.subtasks.where('status').equals('working').toArray();
      const allWorkingTasks = await db.tasks.where('status').equals('working').toArray();
      const now = Date.now();

      await ensureDeviceId();
      await db.transaction('rw', [db.subtasks, db.tasks, db.changeLog], async () => {
        for (const s of allWorkingSubs) {
          if (s.id !== id) {
            const ft = stampUpdatedFields(s.fieldTimestamps, ['status'], now);
            await db.subtasks.update(s.id, { status: 'todo', updatedAt: now, fieldTimestamps: ft });
          }
        }
        for (const t of allWorkingTasks) {
          const ft = stampUpdatedFields(t.fieldTimestamps, ['status'], now);
          await db.tasks.update(t.id, { status: 'todo', updatedAt: now, fieldTimestamps: ft });
        }
        {
          const self = await db.subtasks.get(id);
          const ft = stampUpdatedFields(self?.fieldTimestamps, ['status'], now);
          await db.subtasks.update(id, { status, updatedAt: now, fieldTimestamps: ft });
        }

        // Record changes for all modified entities
        const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
        for (const s of allWorkingSubs) {
          if (s.id !== id) {
            const updated = await db.subtasks.get(s.id);
            if (updated) batch.push({ entityType: 'subtask', entityId: s.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
          }
        }
        for (const t of allWorkingTasks) {
          const updated = await db.tasks.get(t.id);
          if (updated) batch.push({ entityType: 'task', entityId: t.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
        }
        const updatedSelf = await db.subtasks.get(id);
        if (updatedSelf) batch.push({ entityType: 'subtask', entityId: id, operation: 'upsert', data: updatedSelf as unknown as Record<string, unknown> });
        await recordChangeBatchInTx(batch);
      });

      scheduleSyncDebounced();
      return;
    }

    // Track blockedAt
    const subtask = await db.subtasks.get(id);
    const updates: Partial<Subtask> = { status };
    if (status === 'blocked' && subtask?.status !== 'blocked') {
      updates.blockedAt = Date.now();
    } else if (status !== 'blocked' && subtask?.status === 'blocked') {
      updates.blockedAt = undefined;
    }
    // Track completedAt
    if (status === 'done') {
      updates.completedAt = Date.now();
    } else if (subtask?.status === 'done') {
      updates.completedAt = undefined;
    }
    await updateSubtask(id, updates);

    // Auto-complete parent task when all subtasks are done
    if (status === 'done') {
      const sub = await db.subtasks.get(id);
      if (sub) {
        const siblings = await db.subtasks.where('taskId').equals(sub.taskId).toArray();
        const live = siblings.filter((s) => !s.deletedAt);
        if (live.length > 0 && live.every((s) => s.status === 'done')) {
          const parentTask = await db.tasks.get(sub.taskId);
          const acNow = Date.now();
          const taskUpdates: Partial<import('../db/models').Task> = { status: 'done', updatedAt: acNow, completedAt: acNow };

          // Recurrence on auto-complete
          if (parentTask?.recurrenceType && parentTask.recurrenceInterval && parentTask.recurrenceUnit) {
            taskUpdates.lastCompletedAt = acNow;
            if (parentTask.recurrenceType === 'time-based') {
              taskUpdates.nextOccurrence = computeNextOccurrence(
                acNow,
                parentTask.recurrenceInterval,
                parentTask.recurrenceUnit,
              );
            }
          }

          const acFT = stampUpdatedFields(parentTask?.fieldTimestamps, Object.keys(taskUpdates), acNow);
          taskUpdates.fieldTimestamps = acFT;

          await ensureDeviceId();
          await db.transaction('rw', [db.tasks, db.changeLog], async () => {
            await db.tasks.update(sub.taskId, taskUpdates);
            const updatedTask = await db.tasks.get(sub.taskId);
            if (updatedTask) {
              await recordChangeInTx('task', sub.taskId, 'upsert', updatedTask as unknown as Record<string, unknown>);
            }
          });
          scheduleSyncDebounced();
        }
      }
    }
  } catch (error) {
    handleDbError(error, 'set subtask status');
  }
}

export async function addSubtaskLink(subtaskId: string, url: string, title?: string) {
  try {
    const subtask = await db.subtasks.get(subtaskId);
    if (!subtask) return;
    const links: TaskLink[] = [...(subtask.links ?? []), { url, title }];
    await updateSubtask(subtaskId, { links });
  } catch (error) {
    handleDbError(error, 'add subtask link');
  }
}

export async function removeSubtaskLink(subtaskId: string, index: number) {
  try {
    const subtask = await db.subtasks.get(subtaskId);
    if (!subtask) return;
    const links = [...(subtask.links ?? [])];
    links.splice(index, 1);
    await updateSubtask(subtaskId, { links: links.length > 0 ? links : undefined });
  } catch (error) {
    handleDbError(error, 'remove subtask link');
  }
}

export async function deleteSubtask(id: string) {
  try {
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.subtasks, db.changeLog], async () => {
      const existing = await db.subtasks.get(id);
      const ft = stampUpdatedFields(existing?.fieldTimestamps, ['deletedAt'], now);
      await db.subtasks.update(id, { deletedAt: now, updatedAt: now, fieldTimestamps: ft });
      await recordChangeInTx('subtask', id, 'delete');
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'delete subtask');
  }
}

export async function restoreSubtask(id: string) {
  try {
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.subtasks, db.changeLog], async () => {
      const existing = await db.subtasks.get(id);
      const ft = stampUpdatedFields(existing?.fieldTimestamps, ['deletedAt'], now);
      await db.subtasks.update(id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: ft });
      const updated = await db.subtasks.get(id);
      if (updated) {
        await recordChangeInTx('subtask', id, 'upsert', updated as unknown as Record<string, unknown>);
      }
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'restore subtask');
  }
}

export async function convertSubtaskToTask(subtaskId: string, targetListId: string) {
  try {
    const subtask = await db.subtasks.get(subtaskId);
    if (!subtask) return;
    const now = Date.now();
    const newTaskId = newId();
    await ensureDeviceId();
    await db.transaction('rw', [db.subtasks, db.tasks, db.changeLog], async () => {
      const count = await db.tasks.where('listId').equals(targetListId).count();
      const subFT = stampUpdatedFields(subtask.fieldTimestamps, ['deletedAt'], now);
      await db.subtasks.update(subtaskId, { deletedAt: now, updatedAt: now, fieldTimestamps: subFT });
      const newTask: import('../db/models').Task = {
        id: newTaskId,
        listId: targetListId,
        title: subtask.title,
        link: subtask.link,
        linkTitle: subtask.linkTitle,
        dueDate: subtask.dueDate,
        status: subtask.status === 'working' ? 'todo' : subtask.status,
        order: count,
        createdAt: now,
        updatedAt: now,
      };
      newTask.fieldTimestamps = initFieldTimestamps(newTask as unknown as Record<string, unknown>, now);
      await db.tasks.add(newTask);

      await recordChangeInTx('subtask', subtaskId, 'delete');
      const createdTask = await db.tasks.get(newTaskId);
      if (createdTask) {
        await recordChangeInTx('task', newTaskId, 'upsert', createdTask as unknown as Record<string, unknown>);
      }
    });

    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'convert subtask');
  }
}

export async function convertTaskToSubtask(taskId: string, parentTaskId: string) {
  try {
    if (taskId === parentTaskId) return;

    const task = await db.tasks.get(taskId);
    if (!task) return;

    // Don't convert tasks that have subtasks (no deep nesting)
    const existingSubtasks = await db.subtasks.where('taskId').equals(taskId).toArray();
    if (existingSubtasks.some((s) => !s.deletedAt)) return;

    const now = Date.now();
    const newSubtaskId = newId();
    await ensureDeviceId();
    await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
      const parentSubCount = await db.subtasks.where('taskId').equals(parentTaskId).count();

      const newSub: Subtask = {
        id: newSubtaskId,
        taskId: parentTaskId,
        title: task.title,
        link: task.link,
        linkTitle: task.linkTitle,
        dueDate: task.dueDate,
        links: task.links ? [...task.links] : undefined,
        status: task.status === 'working' ? 'todo' : (task.status as import('../db/models').SubtaskStatus),
        order: parentSubCount,
        createdAt: now,
        updatedAt: now,
      };
      newSub.fieldTimestamps = initFieldTimestamps(newSub as unknown as Record<string, unknown>, now);
      await db.subtasks.add(newSub);

      // Soft-delete the original task
      const taskFT = stampUpdatedFields(task.fieldTimestamps, ['deletedAt'], now);
      await db.tasks.update(taskId, { deletedAt: now, updatedAt: now, fieldTimestamps: taskFT });

      await recordChangeInTx('task', taskId, 'delete');
      await recordChangeInTx('subtask', newSubtaskId, 'upsert', newSub as unknown as Record<string, unknown>);
    });

    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'convert task to subtask');
  }
}

export async function reorderSubtasks(orderedIds: string[]) {
  try {
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.subtasks, db.changeLog], async () => {
      for (let i = 0; i < orderedIds.length; i++) {
        const existing = await db.subtasks.get(orderedIds[i]);
        const ft = stampUpdatedFields(existing?.fieldTimestamps, ['order'], now);
        await db.subtasks.update(orderedIds[i], { order: i, updatedAt: now, fieldTimestamps: ft });
      }

      const batch: Array<{ entityType: 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
      for (const id of orderedIds) {
        const sub = await db.subtasks.get(id);
        if (sub) batch.push({ entityType: 'subtask', entityId: id, operation: 'upsert', data: sub as unknown as Record<string, unknown> });
      }
      await recordChangeBatchInTx(batch);
    });

    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'reorder subtasks');
  }
}
