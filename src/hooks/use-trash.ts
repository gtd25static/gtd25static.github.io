import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { purgeOldTrashItems } from '../db/purge';
import { recordChangeInTx, recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { handleDbError } from '../lib/db-error';
import { stampUpdatedFields } from '../sync/field-timestamps';

export interface TrashItem {
  id: string;
  type: 'list' | 'task' | 'subtask';
  title: string;
  deletedAt: number;
  parentTitle?: string;
}

export function useTrash() {
  useEffect(() => {
    purgeOldTrashItems();
  }, []);

  return useLiveQuery(async () => {
    const lists = await db.taskLists.filter((l) => !!l.deletedAt).toArray();
    const tasks = await db.tasks.filter((t) => !!t.deletedAt).toArray();
    const subtasks = await db.subtasks.filter((s) => !!s.deletedAt).toArray();

    const taskMap = new Map<string, string>();
    const allTasks = await db.tasks.toArray();
    for (const t of allTasks) taskMap.set(t.id, t.title);

    const items: TrashItem[] = [
      ...lists.map((l) => ({ id: l.id, type: 'list' as const, title: l.name, deletedAt: l.deletedAt! })),
      ...tasks.map((t) => ({ id: t.id, type: 'task' as const, title: t.title, deletedAt: t.deletedAt! })),
      ...subtasks.map((s) => ({
        id: s.id,
        type: 'subtask' as const,
        title: s.title,
        deletedAt: s.deletedAt!,
        parentTitle: taskMap.get(s.taskId),
      })),
    ];

    items.sort((a, b) => b.deletedAt - a.deletedAt);
    return items;
  }, [], []);
}

export async function permanentlyDelete(item: TrashItem) {
  try {
    await ensureDeviceId();
    switch (item.type) {
      case 'list':
        await db.transaction('rw', [db.taskLists, db.changeLog], async () => {
          await db.taskLists.delete(item.id);
          await recordChangeInTx('taskList', item.id, 'delete');
        });
        break;
      case 'task': {
        const subtasks = await db.subtasks.where('taskId').equals(item.id).toArray();
        await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
          await db.subtasks.where('taskId').equals(item.id).delete();
          await db.tasks.delete(item.id);
          const batch = subtasks.map((s) => ({
            entityType: 'subtask' as const,
            entityId: s.id,
            operation: 'delete' as const,
          }));
          if (batch.length > 0) await recordChangeBatchInTx(batch);
          await recordChangeInTx('task', item.id, 'delete');
        });
        break;
      }
      case 'subtask':
        await db.transaction('rw', [db.subtasks, db.changeLog], async () => {
          await db.subtasks.delete(item.id);
          await recordChangeInTx('subtask', item.id, 'delete');
        });
        break;
    }
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'permanently delete item');
  }
}

export async function restoreFromTrash(item: TrashItem) {
  try {
    const now = Date.now();
    await ensureDeviceId();
    switch (item.type) {
      case 'list': {
        await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.changeLog], async () => {
          const existingList = await db.taskLists.get(item.id);
          const listFT = stampUpdatedFields(existingList?.fieldTimestamps, ['deletedAt'], now);
          await db.taskLists.update(item.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: listFT });
          const tasks = await db.tasks.where('listId').equals(item.id).toArray();
          for (const t of tasks) {
            const tFT = stampUpdatedFields(t.fieldTimestamps, ['deletedAt'], now);
            await db.tasks.update(t.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: tFT });
            const subs = await db.subtasks.where('taskId').equals(t.id).toArray();
            for (const s of subs) {
              const sFT = stampUpdatedFields(s.fieldTimestamps, ['deletedAt'], now);
              await db.subtasks.update(s.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: sFT });
            }
          }
          // Record upserts for restored entities
          const batch: Array<{ entityType: 'taskList' | 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
          const list = await db.taskLists.get(item.id);
          if (list) batch.push({ entityType: 'taskList', entityId: item.id, operation: 'upsert', data: list as unknown as Record<string, unknown> });
          const updatedTasks = await db.tasks.where('listId').equals(item.id).toArray();
          for (const t of updatedTasks) {
            batch.push({ entityType: 'task', entityId: t.id, operation: 'upsert', data: t as unknown as Record<string, unknown> });
            const subs = await db.subtasks.where('taskId').equals(t.id).toArray();
            for (const s of subs) {
              batch.push({ entityType: 'subtask', entityId: s.id, operation: 'upsert', data: s as unknown as Record<string, unknown> });
            }
          }
          await recordChangeBatchInTx(batch);
        });
        break;
      }
      case 'task': {
        await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
          const existingTask = await db.tasks.get(item.id);
          const tFT = stampUpdatedFields(existingTask?.fieldTimestamps, ['deletedAt'], now);
          await db.tasks.update(item.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: tFT });
          const taskSubs = await db.subtasks.where('taskId').equals(item.id).toArray();
          for (const s of taskSubs) {
            const sFT = stampUpdatedFields(s.fieldTimestamps, ['deletedAt'], now);
            await db.subtasks.update(s.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: sFT });
          }
          const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
          const task = await db.tasks.get(item.id);
          if (task) batch.push({ entityType: 'task', entityId: item.id, operation: 'upsert', data: task as unknown as Record<string, unknown> });
          const subs = await db.subtasks.where('taskId').equals(item.id).toArray();
          for (const s of subs) {
            batch.push({ entityType: 'subtask', entityId: s.id, operation: 'upsert', data: s as unknown as Record<string, unknown> });
          }
          await recordChangeBatchInTx(batch);
        });
        break;
      }
      case 'subtask': {
        await db.transaction('rw', [db.subtasks, db.changeLog], async () => {
          const existingSub = await db.subtasks.get(item.id);
          const sFT = stampUpdatedFields(existingSub?.fieldTimestamps, ['deletedAt'], now);
          await db.subtasks.update(item.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: sFT });
          const sub = await db.subtasks.get(item.id);
          if (sub) {
            await recordChangeInTx('subtask', item.id, 'upsert', sub as unknown as Record<string, unknown>);
          }
        });
        break;
      }
    }
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'restore from trash');
  }
}
