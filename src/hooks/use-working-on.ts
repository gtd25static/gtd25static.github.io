import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task, Subtask } from '../db/models';
import { setSubtaskStatus } from './use-subtasks';
import { setTaskStatus } from './use-tasks';
import { recordChangeInTx, recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { handleDbError } from '../lib/db-error';
import { stampUpdatedFields } from '../sync/field-timestamps';

interface WorkingOnState {
  task?: Task;
  subtask?: Subtask;
  isWorking: boolean;
}

export function useWorkingOn(): WorkingOnState {
  const data = useLiveQuery(async () => {
    const workingSubtasks = await db.subtasks.where('status').equals('working').toArray();
    const activeSub = workingSubtasks.find((s) => !s.deletedAt);
    if (activeSub) {
      const task = await db.tasks.get(activeSub.taskId);
      if (task && !task.deletedAt) return { task, subtask: activeSub, isWorking: true };
    }

    const workingTasks = await db.tasks.where('status').equals('working').toArray();
    const activeTask = workingTasks.find((t) => !t.deletedAt);
    if (activeTask) return { task: activeTask, isWorking: true };

    return { isWorking: false };
  }, []);

  return data ?? { isWorking: false };
}

export async function startWorkingOn(subtaskId: string) {
  try {
    // setSubtaskStatus('working') already atomically clears all working items
    await setSubtaskStatus(subtaskId, 'working');
    // Set workedAt on parent task if not already set
    const subtask = await db.subtasks.get(subtaskId);
    if (subtask) {
      const parentTask = await db.tasks.get(subtask.taskId);
      if (parentTask && !parentTask.workedAt) {
        const now = Date.now();
        await ensureDeviceId();
        await db.transaction('rw', [db.tasks, db.changeLog], async () => {
          const ft = stampUpdatedFields(parentTask.fieldTimestamps, ['workedAt'], now);
          await db.tasks.update(parentTask.id, { workedAt: now, updatedAt: now, fieldTimestamps: ft });
          const updated = await db.tasks.get(parentTask.id);
          if (updated) {
            await recordChangeInTx('task', parentTask.id, 'upsert', updated as unknown as Record<string, unknown>);
          }
        });
        scheduleSyncDebounced();
      }
    }
  } catch (error) {
    handleDbError(error, 'start working on subtask');
  }
}

export async function startWorkingOnTask(taskId: string) {
  try {
    const now = Date.now();
    const workingSubs = await db.subtasks.where('status').equals('working').toArray();
    const workingTasks = await db.tasks.where('status').equals('working').toArray();
    await ensureDeviceId();
    await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
      const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];

      // Clear working subtasks
      for (const s of workingSubs) {
        const ft = stampUpdatedFields(s.fieldTimestamps, ['status'], now);
        await db.subtasks.update(s.id, { status: 'todo', updatedAt: now, fieldTimestamps: ft });
        const updated = await db.subtasks.get(s.id);
        if (updated) batch.push({ entityType: 'subtask', entityId: s.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
      }

      // Clear working tasks
      for (const t of workingTasks) {
        if (t.id === taskId) continue; // Will be set to working below
        const ft = stampUpdatedFields(t.fieldTimestamps, ['status'], now);
        await db.tasks.update(t.id, { status: 'todo', updatedAt: now, fieldTimestamps: ft });
        const updated = await db.tasks.get(t.id);
        if (updated) batch.push({ entityType: 'task', entityId: t.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
      }

      // Set target task to working
      const task = await db.tasks.get(taskId);
      const workedAt = task?.workedAt ?? now;
      const ft = stampUpdatedFields(task?.fieldTimestamps, ['status', 'workedAt'], now);
      await db.tasks.update(taskId, { status: 'working' as const, updatedAt: now, workedAt, fieldTimestamps: ft });
      const updated = await db.tasks.get(taskId);
      if (updated) batch.push({ entityType: 'task', entityId: taskId, operation: 'upsert', data: updated as unknown as Record<string, unknown> });

      await recordChangeBatchInTx(batch);
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'start working on task');
  }
}

async function clearWorkingTasks() {
  const working = await db.tasks.where('status').equals('working').toArray();
  if (working.length === 0) return;
  const now = Date.now();
  await ensureDeviceId();
  await db.transaction('rw', [db.tasks, db.changeLog], async () => {
    for (const t of working) {
      const ft = stampUpdatedFields(t.fieldTimestamps, ['status'], now);
      await db.tasks.update(t.id, { status: 'todo', updatedAt: now, fieldTimestamps: ft });
    }
    const batch: Array<{ entityType: 'task'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
    for (const t of working) {
      const updated = await db.tasks.get(t.id);
      if (updated) batch.push({ entityType: 'task', entityId: t.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
    }
    if (batch.length > 0) {
      await recordChangeBatchInTx(batch);
    }
  });
  scheduleSyncDebounced();
}

export async function stopWorking() {
  const now = Date.now();
  const workingSubs = await db.subtasks.where('status').equals('working').toArray();
  if (workingSubs.length > 0) {
    await ensureDeviceId();
    await db.transaction('rw', [db.subtasks, db.changeLog], async () => {
      for (const s of workingSubs) {
        const ft = stampUpdatedFields(s.fieldTimestamps, ['status'], now);
        await db.subtasks.update(s.id, { status: 'todo', updatedAt: now, fieldTimestamps: ft });
      }
      const batch: Array<{ entityType: 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
      for (const s of workingSubs) {
        const updated = await db.subtasks.get(s.id);
        if (updated) batch.push({ entityType: 'subtask', entityId: s.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
      }
      if (batch.length > 0) {
        await recordChangeBatchInTx(batch);
      }
    });
    scheduleSyncDebounced();
  }
  await clearWorkingTasks();
}

export async function markWorkingDone() {
  const working = await db.subtasks.where('status').equals('working').toArray();
  const active = working.find((s) => !s.deletedAt);
  if (!active) {
    // No working subtask — check for working task
    const workingTasks = await db.tasks.where('status').equals('working').toArray();
    const activeTask = workingTasks.find((t) => !t.deletedAt);
    if (activeTask) {
      await setTaskStatus(activeTask.id, 'done');
    }
    return;
  }

  const now = Date.now();
  await ensureDeviceId();
  await db.transaction('rw', [db.subtasks, db.tasks, db.changeLog], async () => {
    const activeFT = stampUpdatedFields(active.fieldTimestamps, ['status', 'completedAt'], now);
    await db.subtasks.update(active.id, { status: 'done', updatedAt: now, completedAt: now, fieldTimestamps: activeFT });
    const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];

    const updatedActive = await db.subtasks.get(active.id);
    if (updatedActive) batch.push({ entityType: 'subtask', entityId: active.id, operation: 'upsert', data: updatedActive as unknown as Record<string, unknown> });

    // Auto-advance to next undone subtask
    const siblings = await db.subtasks.where('taskId').equals(active.taskId).sortBy('order');
    const nextUndone = siblings.find((s) => !s.deletedAt && s.id !== active.id && (s.status === 'todo' || s.status === 'blocked'));
    if (nextUndone) {
      const nextFT = stampUpdatedFields(nextUndone.fieldTimestamps, ['status'], now);
      await db.subtasks.update(nextUndone.id, { status: 'working', updatedAt: now, fieldTimestamps: nextFT });
      const updatedNext = await db.subtasks.get(nextUndone.id);
      if (updatedNext) batch.push({ entityType: 'subtask', entityId: nextUndone.id, operation: 'upsert', data: updatedNext as unknown as Record<string, unknown> });
    } else {
      // All subtasks done — mark parent task done
      const task = await db.tasks.get(active.taskId);
      if (task) {
        const taskFT = stampUpdatedFields(task.fieldTimestamps, ['status', 'completedAt'], now);
        await db.tasks.update(task.id, { status: 'done', updatedAt: now, completedAt: now, fieldTimestamps: taskFT });
        const updatedTask = await db.tasks.get(task.id);
        if (updatedTask) batch.push({ entityType: 'task', entityId: task.id, operation: 'upsert', data: updatedTask as unknown as Record<string, unknown> });
      }
    }

    await recordChangeBatchInTx(batch);
  });

  scheduleSyncDebounced();
}

export async function markWorkingBlocked() {
  const working = await db.subtasks.where('status').equals('working').toArray();
  const active = working.find((s) => !s.deletedAt);
  if (!active) {
    // No working subtask — check for working task
    const workingTasks = await db.tasks.where('status').equals('working').toArray();
    const activeTask = workingTasks.find((t) => !t.deletedAt);
    if (activeTask) {
      await setTaskStatus(activeTask.id, 'blocked');
    }
    return;
  }

  await ensureDeviceId();
  const blockedNow = Date.now();
  await db.transaction('rw', [db.subtasks, db.changeLog], async () => {
    const ft = stampUpdatedFields(active.fieldTimestamps, ['status', 'blockedAt'], blockedNow);
    await db.subtasks.update(active.id, { status: 'blocked', blockedAt: blockedNow, updatedAt: blockedNow, fieldTimestamps: ft });
    const updated = await db.subtasks.get(active.id);
    if (updated) {
      await recordChangeInTx('subtask', active.id, 'upsert', updated as unknown as Record<string, unknown>);
    }
  });
  scheduleSyncDebounced();
}

export async function switchTask() {
  await stopWorking();

  const tasks = await db.tasks.orderBy('createdAt').toArray();
  for (const task of tasks) {
    if (task.deletedAt || task.status === 'done') continue;
    const subtasks = await db.subtasks.where('taskId').equals(task.id).sortBy('order');
    const firstUndone = subtasks.find((s) => !s.deletedAt && s.status === 'todo');
    if (firstUndone) {
      await setSubtaskStatus(firstUndone.id, 'working');
      return { task, subtask: firstUndone };
    }
  }
  return null;
}
