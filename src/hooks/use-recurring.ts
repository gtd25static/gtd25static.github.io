import { db } from '../db';
import type { Task } from '../db/models';
import { recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';

type RecurrenceUnit = 'hours' | 'days' | 'weeks' | 'months';
const UNITS: ReadonlySet<string> = new Set<RecurrenceUnit>(['hours', 'days', 'weeks', 'months']);

// A nextOccurrence decades back (bad data) would step for ever; past this many
// steps the next occurrence is counted from now instead.
const MAX_CATCH_UP_STEPS = 100_000;

export function computeNextOccurrence(
  from: number,
  interval: number,
  unit: RecurrenceUnit,
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
    case 'months': {
      // setMonth overflows a shorter month (31 Jan + 1 month = 3 Mar, February
      // skipped): land on that month's last day instead.
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + interval);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, lastDay));
      break;
    }
  }
  return d.getTime();
}

/**
 * A recurrence that moves nextOccurrence forward: a whole number of a known
 * unit. Anything else (only malformed remote data) left the task due for ever,
 * reset again every minute.
 */
function steppable(t: Task): t is Task & { recurrenceInterval: number; recurrenceUnit: RecurrenceUnit; nextOccurrence: number } {
  return (
    Number.isInteger(t.recurrenceInterval) && t.recurrenceInterval! >= 1 &&
    UNITS.has(t.recurrenceUnit as string) &&
    typeof t.nextOccurrence === 'number' && Number.isFinite(t.nextOccurrence)
  );
}

function isDue(t: Task, now: number): boolean {
  if (t.deletedAt || !t.recurrenceType || !steppable(t) || t.nextOccurrence > now) return false;
  // Time-based: only a done task comes back. Date-based: whatever its status.
  return t.recurrenceType === 'date-based' || t.status === 'done';
}

/** The last occurrence due by `now`, and the first after it — every missed one at once. */
function occurrencesUpTo(from: number, interval: number, unit: RecurrenceUnit, now: number) {
  let last = from;
  let next = computeNextOccurrence(from, interval, unit);
  for (let steps = 0; next <= now; steps++) {
    if (steps >= MAX_CATCH_UP_STEPS) return { last, next: computeNextOccurrence(now, interval, unit) };
    last = next;
    next = computeNextOccurrence(next, interval, unit);
  }
  return { last, next };
}

/**
 * Bring recurring tasks whose occurrence has come back to 'todo'.
 *
 * The reset is stamped with the occurrence's time, not the clock's: every device
 * computes the same one, so a completion made after it — on any device — wins the
 * merge. Stamped "now", a device that had not synced yet reset the task at
 * startup and its stale 'todo' beat the completion made elsewhere hours earlier.
 * A field already set after the occurrence is left alone for the same reason.
 */
export async function checkRecurringTasks() {
  const now = Date.now();
  const candidates = await db.tasks.where('nextOccurrence').belowOrEqual(now).toArray();
  const dueIds = candidates.filter((t) => isDue(t, now)).map((t) => t.id);
  if (dueIds.length === 0) return;

  await ensureDeviceId();
  await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
    const batch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];

    for (const id of dueIds) {
      // Read again inside the transaction: a sync merge may have landed meanwhile.
      const task = await db.tasks.get(id);
      if (!task || !isDue(task, now) || !steppable(task)) continue;
      const { last, next } = occurrencesUpTo(task.nextOccurrence, task.recurrenceInterval, task.recurrenceUnit, now);
      const ft = { ...(task.fieldTimestamps ?? {}) };
      const changes: Partial<Task> = {};
      const setAtOccurrence = <K extends keyof Task>(field: K, value: Task[K]) => {
        if ((ft[field] ?? 0) >= last) return; // set after the occurrence: that wins
        changes[field] = value;
        ft[field] = last;
      };

      setAtOccurrence('status', 'todo');
      // A reset task leaves the Focus Mode set: without clearing focusedAt, a
      // recurring task completed from the Focus view would re-enter it the same
      // day when it flips back to 'todo'. (Dexie removes keys set to undefined.)
      if (task.focusedAt != null) setAtOccurrence('focusedAt', undefined);
      // Archived by an older build's compaction while it waited: hidden from Focus,
      // banners and nudges even once it is due again.
      if (task.archived) setAtOccurrence('archived', undefined);
      // nextOccurrence always moves on (else the task stays due); its stamp never goes back.
      changes.nextOccurrence = next;
      ft.nextOccurrence = Math.max(last, (ft.nextOccurrence ?? 0) + 1);

      const updatedTask: Task = { ...task, ...changes, updatedAt: now, fieldTimestamps: ft };
      for (const key of Object.keys(changes) as Array<keyof Task>) {
        if (changes[key] === undefined) delete updatedTask[key]; // as update() would
      }
      await db.tasks.put(updatedTask);
      batch.push({ entityType: 'task', entityId: task.id, operation: 'upsert', data: updatedTask as unknown as Record<string, unknown> });

      // Reset subtasks to todo, by the same rule
      const subtasks = await db.subtasks.where('taskId').equals(task.id).toArray();
      for (const sub of subtasks) {
        if (sub.deletedAt || sub.status === 'todo' || (sub.fieldTimestamps?.status ?? 0) >= last) continue;
        const updatedSub = { ...sub, status: 'todo' as const, updatedAt: now, fieldTimestamps: { ...(sub.fieldTimestamps ?? {}), status: last } };
        await db.subtasks.put(updatedSub);
        batch.push({ entityType: 'subtask', entityId: sub.id, operation: 'upsert', data: updatedSub as unknown as Record<string, unknown> });
      }
    }

    if (batch.length > 0) {
      await recordChangeBatchInTx(batch);
    }
  });

  scheduleSyncDebounced();
}
