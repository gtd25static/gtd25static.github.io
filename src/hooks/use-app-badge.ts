import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { countAttention, endOfDayMs, taskListIds } from '../lib/attention';

const BASE_TITLE = 'GTD25';

/**
 * Reflects the count of attention-worthy tasks (overdue + due today) in the browser tab
 * title and — on an installed PWA that supports it — the app-icon badge, so the user is
 * gently pulled back. Recomputes on data change, on tab focus, and at day rollover.
 */
export function useAppBadge() {
  const [tick, setTick] = useState(0);

  // Re-evaluate periodically and when the tab regains focus, so "due today" rolls over
  // even without a data change.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    };
    const interval = setInterval(() => setTick((t) => t + 1), 5 * 60 * 1000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const count = useLiveQuery(
    async () => {
      const now = Date.now();
      const cutoff = endOfDayMs(now);
      const [lists, dueTasks, dueSubtasks] = await Promise.all([
        db.taskLists.toArray(),
        db.tasks.where('dueDate').belowOrEqual(cutoff).toArray(),
        db.subtasks.filter((subtask) => subtask.dueDate != null && subtask.dueDate <= cutoff).toArray(),
      ]);
      const parentIds = new Set(dueSubtasks.map((subtask) => subtask.taskId));
      const parents = parentIds.size > 0 ? await db.tasks.bulkGet([...parentIds]) : [];
      const taskMap = new Map(dueTasks.map((task) => [task.id, task]));
      for (const parent of parents) {
        if (parent) taskMap.set(parent.id, parent);
      }
      return countAttention(now, [...taskMap.values()], dueSubtasks, {
        allowedListIds: taskListIds(lists),
      });
    },
    [tick],
    0,
  );

  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
    if ('setAppBadge' in navigator) {
      if (count > 0) void navigator.setAppBadge(count).catch(() => {});
      else void navigator.clearAppBadge?.().catch(() => {});
    }
    return () => {
      document.title = BASE_TITLE;
    };
  }, [count]);
}
