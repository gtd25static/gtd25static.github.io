import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task } from '../db/models';
import { taskListIds } from '../lib/attention';
import { eligibleForFocus } from '../lib/focus-pick';
import {
  FOCUS_SET_SIZE,
  focusMembers,
  focusOverflow,
  localDayKey,
  selectFocusRefill,
} from '../lib/focus-mode';
import { updateTask } from './use-tasks';
import { updateLocalSettings } from './use-settings';

const CHECK_INTERVAL_MS = 60_000;

export type FocusSetState = 'loading' | 'tasks' | 'all-done-today' | 'all-clear';

/**
 * Once-per-local-day Focus Mode maintenance: clear focusedAt on members that are
 * no longer eligible (done/deleted/blocked/archived/list gone), trim a
 * cross-device over-fill to the FOCUS_SET_SIZE oldest, then refill empty slots
 * via selectFocusRefill. The day is stamped BEFORE picks are written (two-tab
 * guard, like useNudges) and even when no slots are empty, so a mid-day
 * completion never refills the same day. All writes go through updateTask /
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

/** Drives maybeRefillFocus on mount, on tab-visible, and once a minute (day rollover). */
export function useFocusModeDaily(): void {
  useEffect(() => {
    void maybeRefillFocus();
    const interval = setInterval(() => void maybeRefillFocus(), CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void maybeRefillFocus();
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
  // which is what makes this count possible. Deleted tasks deliberately don't count.
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const completedTodayCount = data.tasks.filter(
    (t) =>
      t.focusedAt != null &&
      !t.deletedAt &&
      t.status === 'done' &&
      (t.completedAt ?? 0) >= dayStart.getTime(),
  ).length;

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
