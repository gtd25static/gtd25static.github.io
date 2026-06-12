import type { Task } from '../db/models';
import { endOfDayMs } from './attention';
import { eligibleForFocus, pickWeighted } from './focus-pick';

/**
 * Focus Mode: a strict 2-3 task commitment device. Tasks with `focusedAt` set
 * form the focus set; membership is sticky (synced) until the task is completed
 * or deleted. Composition picks happen once per local day; a slot vacated by
 * COMPLETING its task is held until tomorrow (the commitment payoff), while a
 * slot lost any other way (recurring reset, blocked, archived, moved list,
 * cross-device trim) is topped up continuously (see use-focus-mode).
 */

export const FOCUS_LIST_ID = '__focus__';
export const FOCUS_SET_SIZE = 3;
export const FOCUS_URGENT_CAP = 2;
// Due within this many days claims an urgent slot. Deliberately tighter than the
// badge threshold (DUE_SOON_DAYS = 14): only genuinely approaching deadlines.
export const FOCUS_DUE_SOON_DAYS = 7;

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

/** Members beyond the set size (to have focusedAt cleared by the daily and continuous trims). */
export function focusOverflow(members: Task[]): Task[] {
  return members.slice(FOCUS_SET_SIZE);
}

/**
 * Done-today focus carriers: completed focus tasks that HOLD their slot until
 * tomorrow's daily refresh, and drive the "cleared N today" count. Deleted
 * tasks deliberately don't count (deleting disowns the slot). One definition
 * shared by useFocusSet and maintainFocusSet — keep them in lockstep.
 */
export function focusCompletedToday(tasks: Task[], now: number): Task[] {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  return tasks.filter(
    (t) =>
      t.focusedAt != null &&
      !t.deletedAt &&
      t.status === 'done' &&
      (t.completedAt ?? 0) >= dayStart.getTime(),
  );
}

/**
 * Urgency ladder for slot-claiming: 0 = overdue, 1 = due today, 2 = due within
 * FOCUS_DUE_SOON_DAYS, 3 = starred, null = backlog. A starred dated task ranks
 * by its date (best rank wins).
 */
export function urgencyRank(task: Task, now: number): 0 | 1 | 2 | 3 | null {
  if (task.dueDate != null) {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    if (task.dueDate < dayStart.getTime()) return 0;
    if (task.dueDate <= endOfDayMs(now)) return 1;
    if (task.dueDate <= endOfDayMs(now) + FOCUS_DUE_SOON_DAYS * 24 * 60 * 60 * 1000) return 2;
  }
  if (task.starred) return 3;
  return null;
}

/**
 * Pick tasks for the empty slots (FOCUS_SET_SIZE - members). Slots are
 * role-based as a SET-COMPOSITION target: FOCUS_URGENT_CAP urgent slots +
 * the rest backlog. Current members are classified by their *current*
 * urgencyRank and count against their role's quota — so when an urgent member
 * finishes while a backlog member stays, the freed slot refills urgent, not
 * backlog. Urgent picks follow the ladder; backlog picks are age-weighted
 * random. Quotas only bind while both pools have supply: if one pool runs
 * dry the other fills the remainder. Members are excluded from the pool.
 * `rng` injectable for tests.
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

  const urgentMembers = members.filter((t) => urgencyRank(t, now) !== null).length;
  const backlogMembers = members.length - urgentMembers;
  const urgentWant = Math.max(0, FOCUS_URGENT_CAP - urgentMembers);
  const backlogWant = Math.max(0, FOCUS_SET_SIZE - FOCUS_URGENT_CAP - backlogMembers);

  const urgent = pool
    .filter((t) => urgencyRank(t, now) !== null)
    .sort(
      (a, b) =>
        urgencyRank(a, now)! - urgencyRank(b, now)! ||
        (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
  let backlog = pool.filter((t) => urgencyRank(t, now) === null);

  const urgentTake = Math.min(urgent.length, urgentWant, slots);
  const picks = urgent.slice(0, urgentTake);

  const backlogTake = Math.min(backlog.length, backlogWant, slots - picks.length);
  for (let i = 0; i < backlogTake; i++) {
    const pick = pickWeighted(backlog, now, rng)!;
    picks.push(pick);
    backlog = backlog.filter((t) => t.id !== pick.id);
  }

  // One pool short of its quota: fill remaining slots from whatever's left
  // (further urgent first, then weighted backlog) rather than leave slots empty.
  for (let i = urgentTake; picks.length < slots && i < urgent.length; i++) {
    picks.push(urgent[i]);
  }
  while (picks.length < slots && backlog.length > 0) {
    const pick = pickWeighted(backlog, now, rng)!;
    picks.push(pick);
    backlog = backlog.filter((t) => t.id !== pick.id);
  }
  return picks;
}
