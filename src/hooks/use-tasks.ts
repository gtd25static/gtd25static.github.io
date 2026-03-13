import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task, TaskStatus, TaskLink } from '../db/models';
import { newId } from '../lib/id';
import { recordChangeInTx, recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { computeNextOccurrence } from './use-recurring';

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
  data: {
    title: string;
    description?: string;
    link?: string;
    linkTitle?: string;
    dueDate?: number;
    links?: TaskLink[];
    recurrenceType?: 'time-based' | 'date-based';
    recurrenceInterval?: number;
    recurrenceUnit?: 'hours' | 'days' | 'weeks' | 'months';
    nextOccurrence?: number;
    skipFirst?: boolean;
  },
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
    links: data.links,
    recurrenceType: data.recurrenceType,
    recurrenceInterval: data.recurrenceInterval,
    recurrenceUnit: data.recurrenceUnit,
    nextOccurrence: data.nextOccurrence,
    status: data.skipFirst ? 'done' : 'todo',
    lastCompletedAt: data.skipFirst ? now : undefined,
    order: count,
    createdAt: now,
    updatedAt: now,
  };
  await ensureDeviceId();
  await db.transaction('rw', [db.tasks, db.changeLog], async () => {
    await db.tasks.add(task);
    await recordChangeInTx('task', task.id, 'upsert', task as unknown as Record<string, unknown>);
  });
  scheduleSyncDebounced();
  return task;
}

export async function updateTask(id: string, updates: Partial<Task>) {
  await ensureDeviceId();
  await db.transaction('rw', [db.tasks, db.changeLog], async () => {
    await db.tasks.update(id, { ...updates, updatedAt: Date.now() });
    const updated = await db.tasks.get(id);
    if (updated) {
      await recordChangeInTx('task', id, 'upsert', updated as unknown as Record<string, unknown>);
    }
  });
  scheduleSyncDebounced();
}

export async function setTaskStatus(id: string, status: TaskStatus) {
  const task = await db.tasks.get(id);
  const updates: Partial<Task> = { status };

  // Track blockedAt
  if (status === 'blocked' && task?.status !== 'blocked') {
    updates.blockedAt = Date.now();
  } else if (status !== 'blocked' && task?.status === 'blocked') {
    updates.blockedAt = undefined;
  }

  // Track completedAt
  if (status === 'done') {
    updates.completedAt = Date.now();
  } else if (task?.status === 'done') {
    updates.completedAt = undefined;
  }

  // Recurrence: when marking a recurring task done
  if (status === 'done' && task?.recurrenceType && task.recurrenceInterval && task.recurrenceUnit) {
    updates.lastCompletedAt = Date.now();
    if (task.recurrenceType === 'time-based') {
      updates.nextOccurrence = computeNextOccurrence(Date.now(), task.recurrenceInterval, task.recurrenceUnit);
    }
  }

  await updateTask(id, updates);
}

export async function addTaskLink(taskId: string, url: string, title?: string) {
  const task = await db.tasks.get(taskId);
  if (!task) return;
  const links: TaskLink[] = [...(task.links ?? []), { url, title }];
  await updateTask(taskId, { links });
}

export async function removeTaskLink(taskId: string, index: number) {
  const task = await db.tasks.get(taskId);
  if (!task) return;
  const links = [...(task.links ?? [])];
  links.splice(index, 1);
  await updateTask(taskId, { links: links.length > 0 ? links : undefined });
}

export async function deleteTask(id: string) {
  const now = Date.now();
  const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'delete' }> = [];

  await ensureDeviceId();
  await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
    await db.tasks.update(id, { deletedAt: now, updatedAt: now });
    batch.push({ entityType: 'task', entityId: id, operation: 'delete' });

    const subtasks = await db.subtasks.where('taskId').equals(id).toArray();
    for (const sub of subtasks) {
      await db.subtasks.update(sub.id, { deletedAt: now, updatedAt: now });
      batch.push({ entityType: 'subtask', entityId: sub.id, operation: 'delete' });
    }

    await recordChangeBatchInTx(batch);
  });

  scheduleSyncDebounced();
}

export async function restoreTask(id: string) {
  const now = Date.now();
  await ensureDeviceId();
  await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
    await db.tasks.update(id, { deletedAt: undefined, updatedAt: now });
    await db.subtasks.where('taskId').equals(id).modify({ deletedAt: undefined, updatedAt: now });

    const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
    const task = await db.tasks.get(id);
    if (task) batch.push({ entityType: 'task', entityId: id, operation: 'upsert', data: task as unknown as Record<string, unknown> });
    const subtasks = await db.subtasks.where('taskId').equals(id).toArray();
    for (const sub of subtasks) {
      batch.push({ entityType: 'subtask', entityId: sub.id, operation: 'upsert', data: sub as unknown as Record<string, unknown> });
    }
    await recordChangeBatchInTx(batch);
  });

  scheduleSyncDebounced();
}

export async function moveTaskToList(taskId: string, targetListId: string) {
  const count = await db.tasks.where('listId').equals(targetListId).count();
  await ensureDeviceId();
  await db.transaction('rw', [db.tasks, db.changeLog], async () => {
    await db.tasks.update(taskId, { listId: targetListId, order: count, updatedAt: Date.now() });
    const updated = await db.tasks.get(taskId);
    if (updated) {
      await recordChangeInTx('task', taskId, 'upsert', updated as unknown as Record<string, unknown>);
    }
  });
  scheduleSyncDebounced();
}

export async function reorderTasks(orderedIds: string[]) {
  const now = Date.now();
  await ensureDeviceId();
  await db.transaction('rw', [db.tasks, db.changeLog], async () => {
    for (let i = 0; i < orderedIds.length; i++) {
      await db.tasks.update(orderedIds[i], { order: i, updatedAt: now });
    }

    const batch: Array<{ entityType: 'task'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
    for (const id of orderedIds) {
      const task = await db.tasks.get(id);
      if (task) batch.push({ entityType: 'task', entityId: id, operation: 'upsert', data: task as unknown as Record<string, unknown> });
    }
    await recordChangeBatchInTx(batch);
  });

  scheduleSyncDebounced();
}
