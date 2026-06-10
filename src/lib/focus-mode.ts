import type { Task } from '../db/models';
import { endOfDayMs } from './attention';
import { eligibleForFocus, pickWeighted } from './focus-pick';

/**
 * Focus Mode: a strict 2-3 task commitment device. Tasks with `focusedAt` set
 * form the focus set; membership is sticky (synced) until the task is completed
 * or deleted. Empty slots refill at most once per local day (see use-focus-mode).
 */

export const FOCUS_LIST_ID = '__focus__';
export const FOCUS_SET_SIZE = 3;
export const FOCUS_URGENT_CAP = 2;

/** Local-calendar day key ('YYYY-MM-DD') used to gate the once-daily refill. */
export function localDayKey(now: number): string {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * All eligible focus-set members in canonical order: (focusedAt asc, id asc).
 * May exceed FOCUS_SET_SIZE after a cross-device double-fill; callers render
 * the first FOCUS_SET_SIZE and the daily pass trims the rest (focusOverflow),
 * so every device converges on the same set.
 */
export function focusMembers(tasks: Task[], allowedListIds: Set<string>): Task[] {
  return eligibleForFocus(tasks, allowedListIds)
    .filter((t) => t.focusedAt != null)
    .sort((a, b) => a.focusedAt! - b.focusedAt! || a.id.localeCompare(b.id));
}

/** Members beyond the set size (to have focusedAt cleared by the daily trim). */
export function focusOverflow(members: Task[]): Task[] {
  return members.slice(FOCUS_SET_SIZE);
}

/**
 * Urgency ladder for slot-claiming, mirroring the nudge priority order:
 * 0 = overdue, 1 = due today, 2 = starred, null = backlog. A starred overdue
 * task ranks 0 (best rank wins).
 */
export function urgencyRank(task: Task, now: number): 0 | 1 | 2 | null {
  if (task.dueDate != null) {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    if (task.dueDate < dayStart.getTime()) return 0;
    if (task.dueDate <= endOfDayMs(now)) return 1;
  }
  if (task.starred) return 2;
  return null;
}

/**
 * Pick tasks for the empty slots (FOCUS_SET_SIZE - members). Urgent tasks
 * (overdue -> due today -> starred) claim at most FOCUS_URGENT_CAP slots AND
 * at least one slot per refill is reserved for an age-weighted random backlog
 * pick, so lingering tasks keep surfacing. Caps only bind while both pools
 * have supply: if the backlog runs dry, urgent tasks fill the rest (and vice
 * versa). Members are excluded from the pool. `rng` injectable for tests.
 */
export function selectFocusRefill(
  eligible: Task[],
  members: Task[],
  now: number,
  rng: () => number = Math.random,
): Task[] {
  const memberIds = new Set(members.map((t) => t.id));
  const slots = FOCUS_SET_SIZE - members.length;
  const pool = eligible.filter((t) => !memberIds.has(t.id));
  if (slots <= 0 || pool.length === 0) return [];

  const urgent = pool
    .filter((t) => urgencyRank(t, now) !== null)
    .sort(
      (a, b) =>
        urgencyRank(a, now)! - urgencyRank(b, now)! ||
        (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
  const backlog = pool.filter((t) => urgencyRank(t, now) === null);

  const urgentCount = Math.min(urgent.length, FOCUS_URGENT_CAP, Math.max(0, slots - 1));
  const picks = urgent.slice(0, urgentCount);

  let remainingBacklog = backlog;
  while (picks.length < slots && remainingBacklog.length > 0) {
    const pick = pickWeighted(remainingBacklog, now, rng)!;
    picks.push(pick);
    remainingBacklog = remainingBacklog.filter((t) => t.id !== pick.id);
  }
  // Backlog exhausted: let urgent tasks fill beyond the cap rather than leave slots empty.
  for (let i = urgentCount; picks.length < slots && i < urgent.length; i++) {
    picks.push(urgent[i]);
  }
  return picks;
}
