import { useEffect } from 'react';
import { db } from '../db';
import { useLocalSettings, updateLocalSettings } from './use-settings';
import { computeNudge, shouldNudgeNow } from '../lib/nudges';
import { showNudgeNotification } from '../lib/notifications';

const CHECK_INTERVAL_MS = 60_000;

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

      const [tasks, lists] = await Promise.all([db.tasks.toArray(), db.taskLists.toArray()]);
      const nudge = computeNudge(now, tasks, lists);
      if (!nudge) return;

      // Stamp first to minimise the window where two tabs both fire.
      await updateLocalSettings({ lastNudgeAt: now });
      showNudgeNotification(nudge.title, nudge.body, { sound: local.nudgeSoundEnabled !== false });
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
