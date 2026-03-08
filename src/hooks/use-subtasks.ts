import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Subtask, SubtaskStatus } from '../db/models';
import { newId } from '../lib/id';
import { recordChange, recordChangeBatch } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';

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
  const count = await db.subtasks.where('taskId').equals(taskId).count();
  const now = Date.now();
  const subtask: Subtask = {
    id: newId(),
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
  await db.subtasks.add(subtask);
  await recordChange('subtask', subtask.id, 'upsert', subtask as unknown as Record<string, unknown>);
  scheduleSyncDebounced();
  return subtask;
}

export async function updateSubtask(id: string, updates: Partial<Subtask>) {
  await db.subtasks.update(id, { ...updates, updatedAt: Date.now() });
  const updated = await db.subtasks.get(id);
  if (updated) {
    await recordChange('subtask', id, 'upsert', updated as unknown as Record<string, unknown>);
  }
  scheduleSyncDebounced();
}

export async function setSubtaskStatus(id: string, status: SubtaskStatus) {
  if (status === 'working') {
    const allWorkingSubs = await db.subtasks.where('status').equals('working').toArray();
    const allWorkingTasks = await db.tasks.where('status').equals('working').toArray();
    const now = Date.now();
    const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];

    await db.transaction('rw', [db.subtasks, db.tasks], async () => {
      for (const s of allWorkingSubs) {
        if (s.id !== id) {
          await db.subtasks.update(s.id, { status: 'todo', updatedAt: now });
        }
      }
      for (const t of allWorkingTasks) {
        await db.tasks.update(t.id, { status: 'todo', updatedAt: now });
      }
      await db.subtasks.update(id, { status, updatedAt: now });
    });

    // Record changes for all modified entities
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

    await recordChangeBatch(batch);
    scheduleSyncDebounced();
    return;
  }
  await updateSubtask(id, { status });

  // Auto-complete parent task when all subtasks are done
  if (status === 'done') {
    const subtask = await db.subtasks.get(id);
    if (subtask) {
      const siblings = await db.subtasks.where('taskId').equals(subtask.taskId).toArray();
      const live = siblings.filter((s) => !s.deletedAt);
      if (live.length > 0 && live.every((s) => s.status === 'done')) {
        await db.tasks.update(subtask.taskId, { status: 'done', updatedAt: Date.now() });
        const updatedTask = await db.tasks.get(subtask.taskId);
        if (updatedTask) {
          await recordChange('task', subtask.taskId, 'upsert', updatedTask as unknown as Record<string, unknown>);
          scheduleSyncDebounced();
        }
      }
    }
  }
}

export async function deleteSubtask(id: string) {
  const now = Date.now();
  await db.subtasks.update(id, { deletedAt: now, updatedAt: now });
  await recordChange('subtask', id, 'delete');
  scheduleSyncDebounced();
}

export async function restoreSubtask(id: string) {
  await db.subtasks.update(id, { deletedAt: undefined, updatedAt: Date.now() });
  const updated = await db.subtasks.get(id);
  if (updated) {
    await recordChange('subtask', id, 'upsert', updated as unknown as Record<string, unknown>);
  }
  scheduleSyncDebounced();
}

export async function convertSubtaskToTask(subtaskId: string, targetListId: string) {
  const subtask = await db.subtasks.get(subtaskId);
  if (!subtask) return;
  const count = await db.tasks.where('listId').equals(targetListId).count();
  const now = Date.now();
  const newTaskId = newId();
  await db.transaction('rw', [db.subtasks, db.tasks], async () => {
    await db.subtasks.update(subtaskId, { deletedAt: now, updatedAt: now });
    await db.tasks.add({
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
    });
  });

  const newTask = await db.tasks.get(newTaskId);
  await recordChange('subtask', subtaskId, 'delete');
  if (newTask) {
    await recordChange('task', newTaskId, 'upsert', newTask as unknown as Record<string, unknown>);
  }
  scheduleSyncDebounced();
}

export async function reorderSubtasks(orderedIds: string[]) {
  const now = Date.now();
  await db.transaction('rw', db.subtasks, async () => {
    for (let i = 0; i < orderedIds.length; i++) {
      await db.subtasks.update(orderedIds[i], { order: i, updatedAt: now });
    }
  });

  const batch: Array<{ entityType: 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
  for (const id of orderedIds) {
    const sub = await db.subtasks.get(id);
    if (sub) batch.push({ entityType: 'subtask', entityId: id, operation: 'upsert', data: sub as unknown as Record<string, unknown> });
  }
  await recordChangeBatch(batch);
  scheduleSyncDebounced();
}
