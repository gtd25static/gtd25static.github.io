import type { Task } from '../db/models';
import { isInCooldown } from '../hooks/use-follow-ups';
import { SORT_DUE_SOON_DAYS } from './constants';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isDueSoon(task: Task): boolean {
  if (!task.dueDate) return false;
  const now = Date.now();
  return task.dueDate <= now + SORT_DUE_SOON_DAYS * MS_PER_DAY;
}

/**
 * Sort tasks for display: starred first, then due within 7 days (by dueDate asc), then rest by manual order.
 */
export function sortTasksForDisplay(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aStarred = a.starred ? 1 : 0;
    const bStarred = b.starred ? 1 : 0;
    if (aStarred !== bStarred) return bStarred - aStarred;

    const aDueSoon = isDueSoon(a) ? 1 : 0;
    const bDueSoon = isDueSoon(b) ? 1 : 0;
    if (aDueSoon !== bDueSoon) return bDueSoon - aDueSoon;

    // Both due soon: sort by dueDate ascending
    if (aDueSoon && bDueSoon) return a.dueDate! - b.dueDate!;

    // Same tier: preserve manual order
    return a.order - b.order;
  });
}

/**
 * Sort follow-ups for display: starred first, then not snoozed (by order), then snoozed (by order).
 */
export function sortFollowUpsForDisplay(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aStarred = a.starred ? 1 : 0;
    const bStarred = b.starred ? 1 : 0;
    if (aStarred !== bStarred) return bStarred - aStarred;

    const aCool = isInCooldown(a) ? 1 : 0;
    const bCool = isInCooldown(b) ? 1 : 0;
    if (aCool !== bCool) return aCool - bCool;

    return a.order - b.order;
  });
}
