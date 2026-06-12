import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task } from '../db/models';
import { taskListIds } from '../lib/attention';
import { eligibleForFocus } from '../lib/focus-pick';
import {
  FOCUS_SET_SIZE,
  focusCompletedToday,
  focusMembers,
  focusOverflow,
  localDayKey,
  selectFocusRefill,
} from '../lib/focus-mode';
import { updateTask } from './use-tasks';
import { updateLocalSettings } from './use-settings';
import { recordError } from '../lib/diagnostics';

const CHECK_INTERVAL_MS = 60_000;

export type FocusSetState = 'loading' | 'tasks' | 'all-done-today' | 'all-clear';

/**
 * Tier 1 — once-per-local-day refresh: clear focusedAt on members that are no
 * longer eligible (done/deleted/blocked/archived/list gone), trim a
 * cross-device over-fill to the FOCUS_SET_SIZE oldest, then refill empty slots
 * via selectFocusRefill. The day is stamped BEFORE picks are written (two-tab
 * guard, like useNudges) and even when no slots are empty. A mid-day completion
 * holds its slot for the rest of the day — only non-completion exits are topped
 * up, by maintainFocusSet. All writes go through updateTask /
 * updateLocalSettings so sync, field timestamps and at-rest encryption apply.
 */
export async function maybeRefillFocus(now: number = Date.now()): Promise<void> {
  const todayKey = localDayKey(now);
  const local = await db.localSettings.get('local');
  if (!local || local.lastFocusRefillDay === todayKey) return;

  const [tasks, lists] = await Promise.all([db.tasks.toArray(), db.taskLists.toArray()]);
  const allowed = taskListIds(lists);

  const members = focusMembers(tasks, allowed);
  const keep = members.slice(0, FOCUS_SET_SIZE);
  const memberIds = new Set(members.map((t) => t.id));
  // focusedAt carriers to clear: ineligible (stale) + over-fill beyond the set size.
  const stale = tasks.filter((t) => t.focusedAt != null && !memberIds.has(t.id));
  const overflow = focusOverflow(members);

  await updateLocalSettings({ lastFocusRefillDay: todayKey });

  for (const task of [...stale, ...overflow]) {
    await updateTask(task.id, { focusedAt: undefined });
  }

  const picks = selectFocusRefill(eligibleForFocus(tasks, allowed), keep, now);
  for (const pick of picks) {
    await updateTask(pick.id, { focusedAt: now });
  }
}

let maintainInFlight = false;

/**
 * Tier 2 — continuous same-day repair. Keeps the visible set at FOCUS_SET_SIZE
 * when a member leaves for a NON-completion reason (recurring reset, blocked,
 * archived, moved list, cross-device trim). Done-today carriers HOLD their slot
 * (focusCompletedToday) so finishing focus tasks still ends the day — passing
 * them to selectFocusRefill as members occupies their slot and urgency role
 * without being re-pickable (the eligible pool excludes done). Never
 * stale-clears (that would break held slots / the cleared-today count) and
 * writes nothing in steady state. Gated on today's daily refresh having stamped
 * lastFocusRefillDay, so it can't pre-empt the composition pick or run against
 * yesterday's context after midnight. Known wrinkle, accepted: a long-offline
 * date-based recurrer that is also top-urgent can clear/re-pick once per tick
 * while its nextOccurrence catches up — bounded and self-terminating.
 */
export async function maintainFocusSet(now: number = Date.now()): Promise<void> {
  if (maintainInFlight) return;
  maintainInFlight = true;
  try {
    const local = await db.localSettings.get('local');
    if (!local || local.lastFocusRefillDay !== localDayKey(now)) return;

    const [tasks, lists] = await Promise.all([db.tasks.toArray(), db.taskLists.toArray()]);
    const allowed = taskListIds(lists);
    const members = focusMembers(tasks, allowed);
    const keep = members.slice(0, FOCUS_SET_SIZE);
    const overflow = focusOverflow(members);
    const held = focusCompletedToday(tasks, now);
    if (overflow.length === 0 && keep.length + held.length >= FOCUS_SET_SIZE) return;

    for (const task of overflow) {
      await updateTask(task.id, { focusedAt: undefined });
    }
    const picks = selectFocusRefill(eligibleForFocus(tasks, allowed), [...keep, ...held], now);
    for (const pick of picks) {
      await updateTask(pick.id, { focusedAt: now });
    }
  } finally {
    maintainInFlight = false;
  }
}

/**
 * Drives the two maintenance tiers on mount, on tab-visible, and once a minute:
 * the daily refresh first (so a new day is stamped and composed), then the
 * continuous top-up against the freshly stamped day.
 */
export function useFocusModeDaily(): void {
  useEffect(() => {
    const tick = async () => {
      const now = Date.now();
      await maybeRefillFocus(now);
      await maintainFocusSet(now);
    };
    const run = () => void tick().catch((e) => recordError('focus.tick', e));
    run();
    const interval = setInterval(run, CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}

/**
 * Live focus set (≤ FOCUS_SET_SIZE, canonical order) plus the view state:
 * - 'tasks'          — members to show
 * - 'all-done-today' — set cleared today; no refill until tomorrow (the payoff)
 * - 'all-clear'      — nothing eligible at all
 * - 'loading'        — data not ready, or today's refill hasn't run yet
 */
export function useFocusSet(): {
  members: Task[];
  eligibleCount: number;
  completedTodayCount: number;
  state: FocusSetState;
} {
  const data = useLiveQuery(async () => {
    const [tasks, lists, local] = await Promise.all([
      db.tasks.toArray(),
      db.taskLists.toArray(),
      db.localSettings.get('local'),
    ]);
    return { tasks, lists, local };
  }, []);

  if (!data) {
    return { members: [], eligibleCount: 0, completedTodayCount: 0, state: 'loading' };
  }

  const now = Date.now();
  const allowed = taskListIds(data.lists);
  const members = focusMembers(data.tasks, allowed).slice(0, FOCUS_SET_SIZE);
  const eligibleCount = eligibleForFocus(data.tasks, allowed).length;

  // Done focus tasks keep focusedAt until the next daily cleanup (see models.ts),
  // which is what makes this count possible — and what holds their slot against
  // the continuous top-up (maintainFocusSet shares this exact definition).
  const completedTodayCount = focusCompletedToday(data.tasks, now).length;

  // Until today's refill has stamped the day, an empty set is indeterminate —
  // report 'loading' instead of flashing a celebration on first open of the day.
  const refilledToday = data.local?.lastFocusRefillDay === localDayKey(now);
  const state: FocusSetState =
    members.length > 0
      ? 'tasks'
      : !refilledToday
        ? 'loading'
        : eligibleCount === 0
          ? 'all-clear'
          : 'all-done-today';

  return { members, eligibleCount, completedTodayCount, state };
}
