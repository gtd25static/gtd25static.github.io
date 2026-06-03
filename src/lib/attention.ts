import type { Task } from '../db/models';

/** Whole-day difference (target - now) in local calendar days. */
export function dayDiff(now: number, target: number): number {
  const a = new Date(now);
  a.setHours(0, 0, 0, 0);
  const b = new Date(target);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Count of active tasks that need attention now: overdue or due today
 * (`dayDiff(now, dueDate) <= 0`), excluding done/archived/deleted and undated tasks.
 * Used for the app-icon and browser-tab badge.
 */
export function countAttention(now: number, tasks: Task[]): number {
  return tasks.filter(
    (t) =>
      !t.deletedAt &&
      t.status !== 'done' &&
      !t.archived &&
      t.dueDate != null &&
      dayDiff(now, t.dueDate) <= 0,
  ).length;
}
