import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task, TaskStatus, TaskLink } from '../db/models';
import { newId } from '../lib/id';
import { recordChangeInTx, recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { computeNextOccurrence } from './use-recurring';
import { handleDbError } from '../lib/db-error';

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
  try {
    const now = Date.now();
    const id = newId();
    await ensureDeviceId();
    let task!: Task;
    await db.transaction('rw', [db.tasks, db.changeLog], async () => {
      const count = await db.tasks.where('listId').equals(listId).count();
      task = {
        id,
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
      await db.tasks.add(task);
      await recordChangeInTx('task', task.id, 'upsert', task as unknown as Record<string, unknown>);
    });
    scheduleSyncDebounced();
    return task;
  } catch (error) {
    handleDbError(error, 'create task');
    return undefined;
  }
}

export async function updateTask(id: string, updates: Partial<Task>) {
  try {
    await ensureDeviceId();
    await db.transaction('rw', [db.tasks, db.changeLog], async () => {
      await db.tasks.update(id, { ...updates, updatedAt: Date.now() });
      const updated = await db.tasks.get(id);
      if (updated) {
        await recordChangeInTx('task', id, 'upsert', updated as unknown as Record<string, unknown>);
      }
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'update task');
  }
}

export async function setTaskStatus(id: string, status: TaskStatus) {
  try {
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
  } catch (error) {
    handleDbError(error, 'set task status');
  }
}

export async function addTaskLink(taskId: string, url: string, title?: string) {
  try {
    const task = await db.tasks.get(taskId);
    if (!task) return;
    const links: TaskLink[] = [...(task.links ?? []), { url, title }];
    await updateTask(taskId, { links });
  } catch (error) {
    handleDbError(error, 'add task link');
  }
}

export async function removeTaskLink(taskId: string, index: number) {
  try {
    const task = await db.tasks.get(taskId);
    if (!task) return;
    const links = [...(task.links ?? [])];
    links.splice(index, 1);
    await updateTask(taskId, { links: links.length > 0 ? links : undefined });
  } catch (error) {
    handleDbError(error, 'remove task link');
  }
}

export async function deleteTask(id: string) {
  try {
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
  } catch (error) {
    handleDbError(error, 'delete task');
  }
}

export async function restoreTask(id: string) {
  try {
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
  } catch (error) {
    handleDbError(error, 'restore task');
  }
}

export async function moveTaskToList(taskId: string, targetListId: string) {
  try {
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
  } catch (error) {
    handleDbError(error, 'move task');
  }
}

export async function duplicateTask(taskId: string) {
  try {
    const task = await db.tasks.get(taskId);
    if (!task) return undefined;

    // Clone subtasks
    const subtasks = await db.subtasks.where('taskId').equals(taskId).toArray();
    const liveSubtasks = subtasks.filter((s) => !s.deletedAt).sort((a, b) => a.order - b.order);

    const count = await db.tasks.where('listId').equals(task.listId).count();
    const now = Date.now();
    const newTaskId = newId();
    const newTask: Task = {
      id: newTaskId,
      listId: task.listId,
      title: task.title,
      description: task.description,
      link: task.link,
      linkTitle: task.linkTitle,
      links: task.links ? [...task.links] : undefined,
      status: 'todo',
      order: count,
      createdAt: now,
      updatedAt: now,
    };

    await ensureDeviceId();
    await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
      await db.tasks.add(newTask);
      await recordChangeInTx('task', newTaskId, 'upsert', newTask as unknown as Record<string, unknown>);

      for (let i = 0; i < liveSubtasks.length; i++) {
        const sub = liveSubtasks[i];
        const newSubId = newId();
        const newSub = {
          id: newSubId,
          taskId: newTaskId,
          title: sub.title,
          link: sub.link,
          linkTitle: sub.linkTitle,
          links: sub.links ? [...sub.links] : undefined,
          status: 'todo' as const,
          order: i,
          createdAt: now,
          updatedAt: now,
        };
        await db.subtasks.add(newSub);
        await recordChangeInTx('subtask', newSubId, 'upsert', newSub as unknown as Record<string, unknown>);
      }
    });

    scheduleSyncDebounced();
    return newTask;
  } catch (error) {
    handleDbError(error, 'duplicate task');
    return undefined;
  }
}

export async function reorderTasks(orderedIds: string[]) {
  try {
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
  } catch (error) {
    handleDbError(error, 'reorder tasks');
  }
}
