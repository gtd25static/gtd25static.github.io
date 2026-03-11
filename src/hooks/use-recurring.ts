import { db } from '../db';
import { recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';

export function computeNextOccurrence(
  from: number,
  interval: number,
  unit: 'hours' | 'days' | 'weeks' | 'months',
): number {
  const d = new Date(from);
  switch (unit) {
    case 'hours':
      d.setTime(d.getTime() + interval * 60 * 60 * 1000);
      break;
    case 'days':
      d.setDate(d.getDate() + interval);
      break;
    case 'weeks':
      d.setDate(d.getDate() + interval * 7);
      break;
    case 'months':
      d.setMonth(d.getMonth() + interval);
      break;
  }
  return d.getTime();
}

export async function checkRecurringTasks() {
  const now = Date.now();
  // Use indexed query on nextOccurrence instead of full table scan
  const dueTasks = await db.tasks.where('nextOccurrence').belowOrEqual(now).toArray();

  // Find tasks that need to be reset
  const tasksToReset = dueTasks.filter((t) => {
    if (t.deletedAt || !t.recurrenceType || !t.recurrenceInterval || !t.recurrenceUnit) return false;

    if (t.recurrenceType === 'time-based') {
      // Only reset if currently done
      return t.status === 'done';
    }
    // Date-based: reset regardless of status
    return true;
  });

  if (tasksToReset.length === 0) return;

  await ensureDeviceId();
  await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
    const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];

    for (const task of tasksToReset) {
      // Compute new nextOccurrence
      const newNext = computeNextOccurrence(
        task.nextOccurrence!,
        task.recurrenceInterval!,
        task.recurrenceUnit!,
      );

      await db.tasks.update(task.id, {
        status: 'todo',
        nextOccurrence: newNext,
        updatedAt: now,
      });
      const updatedTask = await db.tasks.get(task.id);
      if (updatedTask) {
        batch.push({ entityType: 'task', entityId: task.id, operation: 'upsert', data: updatedTask as unknown as Record<string, unknown> });
      }

      // Reset subtasks to todo
      const subtasks = await db.subtasks.where('taskId').equals(task.id).toArray();
      for (const sub of subtasks) {
        if (sub.deletedAt) continue;
        if (sub.status !== 'todo') {
          await db.subtasks.update(sub.id, { status: 'todo', updatedAt: now });
          const updatedSub = await db.subtasks.get(sub.id);
          if (updatedSub) {
            batch.push({ entityType: 'subtask', entityId: sub.id, operation: 'upsert', data: updatedSub as unknown as Record<string, unknown> });
          }
        }
      }
    }

    if (batch.length > 0) {
      await recordChangeBatchInTx(batch);
    }
  });

  scheduleSyncDebounced();
}
