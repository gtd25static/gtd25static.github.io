import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { TaskList, ListType } from '../db/models';
import { newId } from '../lib/id';
import { recordChangeInTx, recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { INBOX_LIST_NAME } from '../lib/constants';
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

export async function deleteTaskList(id: string) {
  try {
    const now = Date.now();
    const batch: Array<{ entityType: 'taskList' | 'task' | 'subtask'; entityId: string; operation: 'upsert' | 'delete'; data?: Record<string, unknown> }> = [];

    await ensureDeviceId();
    await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.changeLog], async () => {
      const list = await db.taskLists.get(id);
      const listFT = stampUpdatedFields(list?.fieldTimestamps, ['deletedAt'], now);
      await db.taskLists.update(id, { deletedAt: now, updatedAt: now, fieldTimestamps: listFT });
      batch.push({ entityType: 'taskList', entityId: id, operation: 'delete' });

      const tasks = await db.tasks.where('listId').equals(id).toArray();
      for (const task of tasks) {
        const taskFT = stampUpdatedFields(task.fieldTimestamps, ['deletedAt'], now);
        await db.tasks.update(task.id, { deletedAt: now, updatedAt: now, fieldTimestamps: taskFT });
        batch.push({ entityType: 'task', entityId: task.id, operation: 'delete' });

        const subtasks = await db.subtasks.where('taskId').equals(task.id).toArray();
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
    handleDbError(error, 'delete task list');
  }
}

export async function restoreTaskList(id: string) {
  try {
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.changeLog], async () => {
      const existingList = await db.taskLists.get(id);
      const listFT = stampUpdatedFields(existingList?.fieldTimestamps, ['deletedAt'], now);
      await db.taskLists.update(id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: listFT });
      const tasks = await db.tasks.where('listId').equals(id).toArray();
      for (const task of tasks) {
        const taskFT = stampUpdatedFields(task.fieldTimestamps, ['deletedAt'], now);
        await db.tasks.update(task.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: taskFT });
        const subs = await db.subtasks.where('taskId').equals(task.id).toArray();
        for (const sub of subs) {
          const subFT = stampUpdatedFields(sub.fieldTimestamps, ['deletedAt'], now);
          await db.subtasks.update(sub.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: subFT });
        }
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
  } catch (error) {
    handleDbError(error, 'restore task list');
  }
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
  const all = await db.taskLists.toArray();
  const inbox = all.find((l) => !l.deletedAt && l.name === INBOX_LIST_NAME && l.type === 'tasks');
  if (inbox) return inbox.id;
  const list = await createTaskList(INBOX_LIST_NAME, 'tasks');
  return list.id;
}
