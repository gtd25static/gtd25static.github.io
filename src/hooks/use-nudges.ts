import { useEffect } from 'react';
import { db } from '../db';
import { useLocalSettings, updateLocalSettings } from './use-settings';
import { useVault } from './use-vault';
import { computeNudge, shouldNudgeNow } from '../lib/nudges';
import { endOfDayMs } from '../lib/attention';
import { showNudgeNotification } from '../lib/notifications';
import { showFocusNudge } from '../stores/focus-nudge';

const CHECK_INTERVAL_MS = 60_000;

/**
 * Metadata-only check for "is there attention-worthy work" — reads dueDate /
 * status / deletedAt / listId, which are NOT encrypted at rest, and never touches
 * titles. Safe to call while the vault is LOCKED (encrypted rows still expose
 * their metadata), so a generic nudge can decide whether to fire without
 * decrypting anything.
 */
export async function hasPendingWorkLocked(now: number): Promise<boolean> {
  const cutoff = endOfDayMs(now);
  const [lists, dueTasks] = await Promise.all([
    db.taskLists.toArray(),
    db.tasks.where('dueDate').belowOrEqual(cutoff).toArray(),
  ]);
  const allowed = new Set(lists.filter((l) => !l.deletedAt).map((l) => l.id));
  return dueTasks.some(
    (t) => !t.deletedAt && t.status !== 'done' && t.status !== 'blocked' && allowed.has(t.listId),
  );
}

/**
 * Schedules gentle "you have pending work" notifications while the app is running
 * (open tab or installed PWA). Checks roughly every minute and when the tab becomes
 * visible; the actual fire decision (window, interval, content) lives in pure helpers
 * in lib/nudges so it stays testable.
 */
export function useNudges() {
  const settings = useLocalSettings();
  const enabled = !!settings.nudgesEnabled;

  useEffect(() => {
    if (!enabled) return;

    async function maybeNudge() {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const now = Date.now();
      // Re-read the latest record so lastNudgeAt reflects other tabs / prior fires.
      const local = await db.localSettings.get('local');
      if (!local || !shouldNudgeNow(local, now)) return;

      const [tasks, lists, subtasks] = await Promise.all([db.tasks.toArray(), db.taskLists.toArray(), db.subtasks.toArray()]);
      const nudge = computeNudge(now, tasks, lists, Math.random, subtasks);
      if (!nudge) return;

      // Stamp first to minimise the window where two tabs both fire.
      await updateLocalSettings({ lastNudgeAt: now });
      showNudgeNotification(nudge.title, nudge.body, { sound: local.nudgeSoundEnabled !== false });
      showFocusNudge(nudge);
    }

    void maybeNudge();
    const interval = setInterval(() => void maybeNudge(), CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void maybeNudge();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // lastNudgeAt is intentionally excluded so firing a nudge doesn't reset the timer.
  }, [enabled, settings.nudgeIntervalHours, settings.nudgeWindowStart, settings.nudgeWindowEnd]);
}

/**
 * Generic, content-free nudge that keeps working while the vault is LOCKED. It
 * fires on the same schedule as useNudges() but reveals NO task info — just a
 * reminder to unlock GTD25. Gated on metadata-only pending-work detection, and
 * only active while paranoid + locked (otherwise useNudges() handles the
 * detailed nudge). Shares lastNudgeAt so the schedule is continuous across lock.
 */
export function useLockedNudge() {
  const settings = useLocalSettings();
  const { locked } = useVault();
  const enabled = !!settings.nudgesEnabled;

  useEffect(() => {
    if (!enabled || !locked) return;

    async function maybeGenericNudge() {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const now = Date.now();
      const local = await db.localSettings.get('local');
      if (!local || !shouldNudgeNow(local, now)) return;
      // Only nudge when there's actually due/overdue work — using metadata only.
      if (!(await hasPendingWorkLocked(now))) return;

      await updateLocalSettings({ lastNudgeAt: now });
      showNudgeNotification(
        'GTD25',
        'You have items to review — unlock to continue.',
        { sound: local.nudgeSoundEnabled !== false },
      );
    }

    void maybeGenericNudge();
    const interval = setInterval(() => void maybeGenericNudge(), CHECK_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void maybeGenericNudge(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, locked, settings.nudgeIntervalHours, settings.nudgeWindowStart, settings.nudgeWindowEnd]);
}
