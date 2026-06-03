import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { countAttention } from '../lib/attention';

const BASE_TITLE = 'GTD25';

function endOfTodayMs(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

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
      const due = await db.tasks.where('dueDate').belowOrEqual(endOfTodayMs()).toArray();
      return countAttention(Date.now(), due);
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
