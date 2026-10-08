import type { Task } from '../db/models';
import { isInCooldown, lastDiscussedAt } from '../hooks/use-follow-ups';
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
 * Sort tasks by due date ascending (tasks without due dates go last), then by manual order.
 */
export function sortTasksByDate(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aHas = a.dueDate ? 1 : 0;
    const bHas = b.dueDate ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    if (aHas && bHas) return a.dueDate! - b.dueDate!;
    return a.order - b.order;
  });
}

/**
 * Sort tasks alphabetically by title (case-insensitive).
 */
export function sortTasksByName(tasks: Task[]): Task[] {
  // `?? ''`: a row an older Paranoid disable left encrypted has no title (see isMergeCandidate).
  return [...tasks].sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' }));
}

/**
 * Sort completed tasks with the newest completion first.
 */
export function sortCompletedTasksForDisplay(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aCompleted = a.completedAt ?? a.updatedAt;
    const bCompleted = b.completedAt ?? b.updatedAt;
    if (aCompleted !== bCompleted) return bCompleted - aCompleted;
    return b.order - a.order;
  });
}

/**
 * Sort follow-ups for display: starred first, then not snoozed (newest order first), then snoozed (newest order first).
 */
export function sortFollowUpsForDisplay(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aStarred = a.starred ? 1 : 0;
    const bStarred = b.starred ? 1 : 0;
    if (aStarred !== bStarred) return bStarred - aStarred;

    const aCool = isInCooldown(a) ? 1 : 0;
    const bCool = isInCooldown(b) ? 1 : 0;
    if (aCool !== bCool) return aCool - bCool;

    return b.order - a.order;
  });
}

/** How a follow-up list orders its awake cards: by hand, by due date, or stalest topic first. */
export type FollowUpSort = 'manual' | 'date' | 'discussed';

/**
 * Sort follow-ups by when they were last discussed, longest ago first (a topic
 * never discussed counts from its creation), then by newest manual order.
 */
export function sortFollowUpsByLastDiscussed(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => lastDiscussedAt(a) - lastDiscussedAt(b) || b.order - a.order);
}

/**
 * A follow-up list's active cards as the screen shows them: awake ones in the
 * chosen order, snoozed ones after them and left out of `visible` unless shown.
 * FollowUpList and the keyboard both use it, so j/k walk the cards on screen.
 */
export function arrangeFollowUps(
  active: Task[],
  view: { sort: FollowUpSort; showSnoozed: boolean },
): { visible: Task[]; snoozed: Task[] } {
  const displayed = sortFollowUpsForDisplay(active);
  const snoozed = displayed.filter(isInCooldown);
  const awake = displayed.filter((t) => !isInCooldown(t));
  // By hand, a starred snoozed card keeps its place among the starred.
  const all = view.sort === 'date' ? [...sortTasksByDate(awake), ...snoozed]
    : view.sort === 'discussed' ? [...sortFollowUpsByLastDiscussed(awake), ...snoozed]
    : displayed;
  return { visible: view.showSnoozed ? all : all.filter((t) => !isInCooldown(t)), snoozed };
}

/** How long a task just marked done stays in the active list, so the tick is seen. */
export const RECENTLY_DONE_MS = 60_000;

/**
 * What is left of that minute for `task` (≤ 0: none). Counted from completedAt:
 * from updatedAt, editing a long-completed task brought it back for a minute.
 */
export function recentlyDoneRemainingMs(task: Task, now: number): number {
  if (task.status !== 'done') return 0;
  return RECENTLY_DONE_MS - (now - (task.completedAt ?? task.updatedAt));
}
