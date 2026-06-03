import type { Task, TaskList } from '../db/models';
import { isInboxList } from './constants';

export interface NudgeContent {
  title: string;
  body: string;
}

/** Subset of LocalSettings the nudge scheduler depends on (kept narrow for testability). */
export interface NudgeSettings {
  nudgesEnabled?: boolean;
  nudgeIntervalHours?: number;
  nudgeWindowStart?: number;
  nudgeWindowEnd?: number;
  lastNudgeAt?: number;
}

export const NUDGE_DEFAULTS = {
  intervalHours: 3,
  windowStart: 9,
  windowEnd: 18,
} as const;

// Floor so brand-new tasks keep a tiny (non-zero) chance of being picked.
const MIN_AGE_WEIGHT_MS = 60 * 60 * 1000;
const MAX_TITLE_LEN = 60;

function truncate(title: string): string {
  const t = title.trim();
  return t.length > MAX_TITLE_LEN ? `${t.slice(0, MAX_TITLE_LEN - 1)}…` : t;
}

/** Whole-day difference between two timestamps (target - now), using local calendar days. */
function dayDiff(now: number, target: number): number {
  const a = new Date(now);
  a.setHours(0, 0, 0, 0);
  const b = new Date(target);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function isActive(t: Task): boolean {
  // Mirrors the "active" predicate used across the app (Sidebar/useAllTaskCounts,
  // use-motivation-stats): not deleted, not done, not archived.
  return !t.deletedAt && t.status !== 'done' && !t.archived;
}

/**
 * Pick a single task at random, weighted linearly by age (now - createdAt) so the
 * older a task is the more likely it is to be picked — but no task is guaranteed.
 * Returns null for an empty list. `rng` is injectable for deterministic tests.
 */
export function pickWeightedByAge(tasks: Task[], now: number, rng: () => number = Math.random): Task | null {
  if (tasks.length === 0) return null;

  const weights = tasks.map((t) => Math.max(now - t.createdAt, MIN_AGE_WEIGHT_MS));
  const total = weights.reduce((sum, w) => sum + w, 0);

  let r = rng() * total;
  for (let i = 0; i < tasks.length; i++) {
    r -= weights[i];
    if (r < 0) return tasks[i];
  }
  return tasks[tasks.length - 1]; // float-rounding safety net
}

/**
 * Compute the highest-priority nudge message given the current data, or null if there
 * is nothing worth nudging about. Priority ladder:
 *   1. Overdue tasks
 *   2. Tasks due today
 *   3. Inbox backlog
 *   4. Fallback: a random active task (older-weighted) — only when nothing is
 *      overdue or due today.
 */
export function computeNudge(
  now: number,
  tasks: Task[],
  lists: TaskList[],
  rng: () => number = Math.random,
): NudgeContent | null {
  const inboxIds = new Set(
    lists.filter((l) => !l.deletedAt && isInboxList(l)).map((l) => l.id),
  );

  const active = tasks.filter(isActive);

  const overdue = active.filter((t) => t.dueDate != null && dayDiff(now, t.dueDate) < 0);
  const dueToday = active.filter((t) => t.dueDate != null && dayDiff(now, t.dueDate) === 0);
  const inbox = active.filter((t) => inboxIds.has(t.listId));

  // 1. Overdue
  if (overdue.length > 0) {
    const earliest = overdue.reduce((a, b) => (a.dueDate! <= b.dueDate! ? a : b));
    return {
      title: 'Overdue tasks',
      body:
        overdue.length === 1
          ? `“${truncate(earliest.title)}” is overdue.`
          : `${overdue.length} tasks are overdue, including “${truncate(earliest.title)}”.`,
    };
  }

  // 2. Due today
  if (dueToday.length > 0) {
    return {
      title: 'Due today',
      body:
        dueToday.length === 1
          ? `“${truncate(dueToday[0].title)}” is due today.`
          : `${dueToday.length} tasks are due today.`,
    };
  }

  // 3. Inbox backlog
  if (inbox.length > 0) {
    return {
      title: 'Inbox needs triage',
      body:
        inbox.length === 1
          ? '1 item is waiting in your Inbox.'
          : `${inbox.length} items are waiting in your Inbox.`,
    };
  }

  // 4. Fallback: random older-weighted active task (gated on no overdue / due-today).
  const pick = pickWeightedByAge(active, now, rng);
  if (!pick) return null;
  return {
    title: 'A gentle nudge',
    body: `Maybe pick this back up: “${truncate(pick.title)}”?`,
  };
}

/**
 * Pure gate deciding whether a nudge may fire at `now`: enabled, inside the active
 * hour window, and at least the configured interval since the last nudge.
 * The window may wrap past midnight (start > end).
 */
export function shouldNudgeNow(settings: NudgeSettings, now: number): boolean {
  if (!settings.nudgesEnabled) return false;

  const start = settings.nudgeWindowStart ?? NUDGE_DEFAULTS.windowStart;
  const end = settings.nudgeWindowEnd ?? NUDGE_DEFAULTS.windowEnd;
  const hour = new Date(now).getHours();

  const inWindow =
    start === end
      ? false // empty window → never
      : start < end
        ? hour >= start && hour < end
        : hour >= start || hour < end; // wraps past midnight
  if (!inWindow) return false;

  const intervalMs = (settings.nudgeIntervalHours ?? NUDGE_DEFAULTS.intervalHours) * 60 * 60 * 1000;
  if (settings.lastNudgeAt != null && now - settings.lastNudgeAt < intervalMs) return false;

  return true;
}
