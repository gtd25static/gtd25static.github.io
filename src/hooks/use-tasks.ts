import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task, TaskStatus } from '../db/models';
import { newId } from '../lib/id';
import { recordChange, recordChangeBatch } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';

export function useTasks(listId: string | null) {
  return useLiveQuery(
    async () => {
      if (!listId) return [];
      const all = await db.tasks.where('listId').equals(listId).sortBy('order');
      return all.filter((t) => !t.deletedAt);
    },
    [listId],
    [],
  );
}

export function useTask(taskId: string | undefined) {
  return useLiveQuery(
    () => (taskId ? db.tasks.get(taskId) : undefined),
    [taskId],
  );
}

export async function createTask(
  listId: string,
  data: { title: string; description?: string; link?: string; linkTitle?: string; dueDate?: number },
) {
  const count = await db.tasks.where('listId').equals(listId).count();
  const now = Date.now();
  const task: Task = {
    id: newId(),
    listId,
    title: data.title,
    description: data.description,
    link: data.link,
    linkTitle: data.linkTitle,
    dueDate: data.dueDate,
    status: 'todo',
    order: count,
    createdAt: now,
    updatedAt: now,
  };
  await db.tasks.add(task);
  await recordChange('task', task.id, 'upsert', task as unknown as Record<string, unknown>);
  scheduleSyncDebounced();
  return task;
}

export async function updateTask(id: string, updates: Partial<Task>) {
  await db.tasks.update(id, { ...updates, updatedAt: Date.now() });
  const updated = await db.tasks.get(id);
  if (updated) {
    await recordChange('task', id, 'upsert', updated as unknown as Record<string, unknown>);
  }
  scheduleSyncDebounced();
}

export async function setTaskStatus(id: string, status: TaskStatus) {
  await updateTask(id, { status });
}

export async function deleteTask(id: string) {
  const now = Date.now();
  const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'delete' }> = [];

  await db.transaction('rw', [db.tasks, db.subtasks], async () => {
    await db.tasks.update(id, { deletedAt: now, updatedAt: now });
    batch.push({ entityType: 'task', entityId: id, operation: 'delete' });

    const subtasks = await db.subtasks.where('taskId').equals(id).toArray();
    for (const sub of subtasks) {
      await db.subtasks.update(sub.id, { deletedAt: now, updatedAt: now });
      batch.push({ entityType: 'subtask', entityId: sub.id, operation: 'delete' });
    }
  });

  await recordChangeBatch(batch);
  scheduleSyncDebounced();
}

export async function restoreTask(id: string) {
  const now = Date.now();
  await db.transaction('rw', [db.tasks, db.subtasks], async () => {
    await db.tasks.update(id, { deletedAt: undefined, updatedAt: now });
    await db.subtasks.where('taskId').equals(id).modify({ deletedAt: undefined, updatedAt: now });
  });

  const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
  const task = await db.tasks.get(id);
  if (task) batch.push({ entityType: 'task', entityId: id, operation: 'upsert', data: task as unknown as Record<string, unknown> });
  const subtasks = await db.subtasks.where('taskId').equals(id).toArray();
  for (const sub of subtasks) {
    batch.push({ entityType: 'subtask', entityId: sub.id, operation: 'upsert', data: sub as unknown as Record<string, unknown> });
  }
  await recordChangeBatch(batch);
  scheduleSyncDebounced();
}

export async function moveTaskToList(taskId: string, targetListId: string) {
  const count = await db.tasks.where('listId').equals(targetListId).count();
  await db.tasks.update(taskId, { listId: targetListId, order: count, updatedAt: Date.now() });
  const updated = await db.tasks.get(taskId);
  if (updated) {
    await recordChange('task', taskId, 'upsert', updated as unknown as Record<string, unknown>);
  }
  scheduleSyncDebounced();
}

export async function reorderTasks(orderedIds: string[]) {
  const now = Date.now();
  await db.transaction('rw', db.tasks, async () => {
    for (let i = 0; i < orderedIds.length; i++) {
      await db.tasks.update(orderedIds[i], { order: i, updatedAt: now });
    }
  });

  const batch: Array<{ entityType: 'task'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
  for (const id of orderedIds) {
    const task = await db.tasks.get(id);
    if (task) batch.push({ entityType: 'task', entityId: id, operation: 'upsert', data: task as unknown as Record<string, unknown> });
  }
  await recordChangeBatch(batch);
  scheduleSyncDebounced();
}
