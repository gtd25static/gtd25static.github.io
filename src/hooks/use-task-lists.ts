import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { TaskList, ListType } from '../db/models';
import { newId } from '../lib/id';
import { recordChangeInTx, recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';

export function useTaskLists() {
  const allLists = useLiveQuery(
    () => db.taskLists.orderBy('order').toArray(),
    [],
  );

  return allLists?.filter((l) => !l.deletedAt) ?? [];
}

export async function createTaskList(name: string, type: ListType = 'tasks') {
  const count = await db.taskLists.count();
  const now = Date.now();
  const list: TaskList = {
    id: newId(),
    name,
    type,
    order: count,
    createdAt: now,
    updatedAt: now,
  };
  await ensureDeviceId();
  await db.transaction('rw', [db.taskLists, db.changeLog], async () => {
    await db.taskLists.add(list);
    await recordChangeInTx('taskList', list.id, 'upsert', list as unknown as Record<string, unknown>);
  });
  scheduleSyncDebounced();
  return list;
}

export async function updateTaskList(id: string, updates: Partial<Pick<TaskList, 'name' | 'type'>>) {
  await ensureDeviceId();
  await db.transaction('rw', [db.taskLists, db.changeLog], async () => {
    await db.taskLists.update(id, { ...updates, updatedAt: Date.now() });
    const updated = await db.taskLists.get(id);
    if (updated) {
      await recordChangeInTx('taskList', id, 'upsert', updated as unknown as Record<string, unknown>);
    }
  });
  scheduleSyncDebounced();
}

export async function deleteTaskList(id: string) {
  const now = Date.now();
  const batch: Array<{ entityType: 'taskList' | 'task' | 'subtask'; entityId: string; operation: 'upsert' | 'delete'; data?: Record<string, unknown> }> = [];

  await ensureDeviceId();
  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.changeLog], async () => {
    await db.taskLists.update(id, { deletedAt: now, updatedAt: now });
    batch.push({ entityType: 'taskList', entityId: id, operation: 'delete' });

    const tasks = await db.tasks.where('listId').equals(id).toArray();
    for (const task of tasks) {
      await db.tasks.update(task.id, { deletedAt: now, updatedAt: now });
      batch.push({ entityType: 'task', entityId: task.id, operation: 'delete' });

      const subtasks = await db.subtasks.where('taskId').equals(task.id).toArray();
      for (const sub of subtasks) {
        await db.subtasks.update(sub.id, { deletedAt: now, updatedAt: now });
        batch.push({ entityType: 'subtask', entityId: sub.id, operation: 'delete' });
      }
    }

    await recordChangeBatchInTx(batch);
  });

  scheduleSyncDebounced();
}

export async function restoreTaskList(id: string) {
  const now = Date.now();
  await ensureDeviceId();
  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.changeLog], async () => {
    await db.taskLists.update(id, { deletedAt: undefined, updatedAt: now });
    const tasks = await db.tasks.where('listId').equals(id).toArray();
    for (const task of tasks) {
      await db.tasks.update(task.id, { deletedAt: undefined, updatedAt: now });
      await db.subtasks.where('taskId').equals(task.id).modify({ deletedAt: undefined, updatedAt: now });
    }

    // Re-read updated entities for upsert entries
    const batch: Array<{ entityType: 'taskList' | 'task' | 'subtask'; entityId: string; operation: 'upsert' | 'delete'; data?: Record<string, unknown> }> = [];
    const list = await db.taskLists.get(id);
    if (list) batch.push({ entityType: 'taskList', entityId: id, operation: 'upsert', data: list as unknown as Record<string, unknown> });
    const updatedTasks = await db.tasks.where('listId').equals(id).toArray();
    for (const task of updatedTasks) {
      batch.push({ entityType: 'task', entityId: task.id, operation: 'upsert', data: task as unknown as Record<string, unknown> });
      const subtasks = await db.subtasks.where('taskId').equals(task.id).toArray();
      for (const sub of subtasks) {
        batch.push({ entityType: 'subtask', entityId: sub.id, operation: 'upsert', data: sub as unknown as Record<string, unknown> });
      }
    }
    await recordChangeBatchInTx(batch);
  });

  scheduleSyncDebounced();
}

export async function reorderTaskLists(orderedIds: string[]) {
  const now = Date.now();
  await ensureDeviceId();
  await db.transaction('rw', [db.taskLists, db.changeLog], async () => {
    for (let i = 0; i < orderedIds.length; i++) {
      await db.taskLists.update(orderedIds[i], { order: i, updatedAt: now });
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
}
