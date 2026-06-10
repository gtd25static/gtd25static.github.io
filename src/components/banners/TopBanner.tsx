import { useState, useEffect, useDeferredValue } from 'react';
import { useDueSoon } from '../../hooks/use-due-soon';
import { useAppState } from '../../stores/app-state';
import { useShallow } from 'zustand/react/shallow';
import { daysUntil } from '../../lib/date-utils';
import { db } from '../../db';
import { MotivationBanner } from './MotivationBanner';
import { FollowUpsReadyBanner } from './FollowUpsReadyBanner';

interface DueBucket {
  label: string;
  colorClass: string;
  items: Array<{ type: 'task' | 'subtask'; id: string; taskId: string; title: string; dueDate: number; parentTitle?: string }>;
}

function DueSoonSection() {
  const [refreshKey, setRefreshKey] = useState(0);
  const rawItems = useDueSoon(refreshKey);
  const items = useDeferredValue(rawItems);
  const { selectList, toggleTaskExpanded } = useAppState(useShallow(s => ({ selectList: s.selectList, toggleTaskExpanded: s.toggleTaskExpanded })));

  // Auto-refresh at midnight
  useEffect(() => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    const timeout = setTimeout(() => {
      setRefreshKey((k) => k + 1);
    }, msUntilMidnight);
    return () => clearTimeout(timeout);
  }, []);

  if (items.length === 0) return null;

  // Group into buckets
  const buckets: DueBucket[] = [
    { label: 'Overdue', colorClass: 'text-red-600 dark:text-red-400 font-bold', items: [] },
    { label: 'Today', colorClass: 'text-red-600 dark:text-red-400', items: [] },
    { label: 'Within 3 days', colorClass: 'text-orange-600 dark:text-orange-400', items: [] },
    { label: 'Within 7 days', colorClass: 'text-yellow-600 dark:text-yellow-400', items: [] },
    { label: 'Within 14 days', colorClass: 'text-zinc-500 dark:text-zinc-400', items: [] },
  ];

  for (const item of items) {
    const days = daysUntil(item.dueDate);
    if (days < 0) buckets[0].items.push(item);
    else if (days === 0) buckets[1].items.push(item);
    else if (days <= 3) buckets[2].items.push(item);
    else if (days <= 7) buckets[3].items.push(item);
    else buckets[4].items.push(item);
  }

  const nonEmpty = buckets.filter((b) => b.items.length > 0);
  if (nonEmpty.length === 0) return null;

  async function handleClick(item: { type: string; id: string; taskId: string }) {
    if (item.type === 'task') {
      const task = await db.tasks.get(item.taskId);
      if (task) {
        selectList(task.listId);
        toggleTaskExpanded(task.id);
      }
    } else {
      const subtask = await db.subtasks.get(item.id);
      if (subtask) {
        const task = await db.tasks.get(subtask.taskId);
        if (task) {
          selectList(task.listId);
          toggleTaskExpanded(task.id);
        }
      }
    }
  }

  return (
    <div className="border-b border-zinc-100 px-5 py-2.5 md:py-1.5 dark:border-zinc-800">
      <div className="flex items-start gap-3">
        <span className="shrink-0 text-sm md:text-xs font-medium text-zinc-400 pt-0.5 flex items-center gap-1">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="opacity-70">
            <path d="M4 1v2M12 1v2M1 6h14M3 3h10a2 2 0 012 2v8a2 2 0 01-2 2H3a2 2 0 01-2-2V5a2 2 0 012-2z" />
          </svg>
          Due soon
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {nonEmpty.map((bucket) => (
            <div key={bucket.label} className="flex items-center gap-1">
              <span className={`text-sm md:text-xs font-medium ${bucket.colorClass}`}>{bucket.label}:</span>
              {bucket.items.slice(0, 3).map((item) => {
                const days = daysUntil(item.dueDate);
                const suffix = days < 0 ? ` (${Math.abs(days)}d overdue)` : '';
                return (
                  <button
                    key={item.id}
                    onClick={() => handleClick(item)}
                    className="rounded-full px-2 py-1 md:py-0.5 text-sm md:text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <span className="max-w-[120px] truncate text-zinc-600 dark:text-zinc-300">
                      {item.parentTitle ? `${item.parentTitle} > ` : ''}{item.title}
                    </span>
                    {suffix && <span className={`ml-1 ${bucket.colorClass}`}>{suffix}</span>}
                  </button>
                );
              })}
              {bucket.items.length > 3 && (
                <span className="text-xs text-zinc-400">+{bucket.items.length - 3}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TopBanner() {
  return (
    <>
      <DueSoonSection />
      <FollowUpsReadyBanner />
      <MotivationBanner />
    </>
  );
}
