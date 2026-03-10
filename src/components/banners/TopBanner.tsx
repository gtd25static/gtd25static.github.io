import { useState, useEffect } from 'react';
import { useWorkingOn, markWorkingDone, markWorkingBlocked, stopWorking } from '../../hooks/use-working-on';
import { useSuggestion } from '../../hooks/use-suggestion';
import { useDueSoon } from '../../hooks/use-due-soon';
import { useAppState } from '../../stores/app-state';
import { daysUntil } from '../../lib/date-utils';
import { startWorkingOn, startWorkingOnTask } from '../../hooks/use-working-on';
import { db } from '../../db';

function WorkingSection() {
  const { task, subtask, isWorking } = useWorkingOn();
  const { selectList, toggleTaskExpanded } = useAppState();

  if (!isWorking || !task) return null;

  function navigateToTask() {
    if (!task) return;
    selectList(task.listId);
    toggleTaskExpanded(task.id);
  }

  return (
    <div className="flex items-center gap-2 border-b border-accent-100 bg-accent-50/60 px-5 py-2.5 md:py-1.5 dark:border-accent-800/40 dark:bg-accent-950/50">
      <span className="shrink-0 text-sm md:text-xs font-medium text-zinc-400">Working on</span>
      <button
        onClick={navigateToTask}
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 md:py-1 text-sm md:text-xs hover:bg-accent-100 dark:hover:bg-accent-900/40"
      >
        <span className="max-w-[200px] truncate font-medium text-accent-700 dark:text-accent-300">{task.title}</span>
        {subtask && (
          <>
            <span className="text-zinc-400">&rsaquo;</span>
            <span className="max-w-[200px] truncate text-zinc-600 dark:text-zinc-300">{subtask.title}</span>
          </>
        )}
      </button>
      <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-700 shrink-0" />
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => markWorkingDone()}
          className="rounded-full bg-accent-600 px-3 py-1.5 md:py-1 text-sm md:text-xs font-semibold text-white hover:bg-accent-700"
        >Done</button>
        <button
          onClick={() => markWorkingBlocked()}
          className="rounded-full px-2.5 py-1.5 md:py-1 text-sm md:text-xs font-medium text-zinc-500 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >Blocked</button>
        <button
          onClick={() => stopWorking()}
          className="rounded-full px-2.5 py-1.5 md:py-1 text-sm md:text-xs font-medium text-zinc-400 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >Stop</button>
      </div>
    </div>
  );
}

function SuggestionSection() {
  const { isWorking } = useWorkingOn();
  const { suggestion, rollAgain } = useSuggestion();
  const { selectList, toggleTaskExpanded } = useAppState();

  // Don't show suggestion while working on something
  if (isWorking) return null;
  if (!suggestion) return null;

  function navigateToTask() {
    if (!suggestion) return;
    selectList(suggestion.listId);
    toggleTaskExpanded(suggestion.taskId);
  }

  async function handleWork() {
    if (!suggestion) return;
    if (suggestion.subtaskId) {
      await startWorkingOn(suggestion.subtaskId);
    } else {
      await startWorkingOnTask(suggestion.taskId);
    }
  }

  return (
    <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-2.5 md:py-1.5 dark:border-zinc-800">
      <span className="shrink-0 text-sm md:text-xs font-medium text-zinc-400">Next up</span>
      <button
        onClick={navigateToTask}
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 md:py-1 text-sm md:text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span className="max-w-[200px] truncate font-medium text-zinc-700 dark:text-zinc-300">{suggestion.taskTitle}</span>
        {suggestion.subtaskTitle && (
          <>
            <span className="text-zinc-400">&rsaquo;</span>
            <span className="max-w-[200px] truncate text-zinc-500 dark:text-zinc-300">{suggestion.subtaskTitle}</span>
          </>
        )}
      </button>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={handleWork}
          className="rounded-full bg-accent-600 px-3 py-1.5 md:py-1 text-sm md:text-xs font-semibold text-white hover:bg-accent-700"
        >Work</button>
        <button
          onClick={rollAgain}
          className="rounded-full px-2.5 py-1.5 md:py-1 text-sm md:text-xs font-medium text-zinc-400 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          title="Pick a different task"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M1 8a7 7 0 0113.6-2.3M15 8a7 7 0 01-13.6 2.3" strokeLinecap="round" />
            <path d="M14.6 2v3.7h-3.7M1.4 14v-3.7h3.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

interface DueBucket {
  label: string;
  colorClass: string;
  items: Array<{ type: 'task' | 'subtask'; id: string; taskId: string; title: string; dueDate: number; parentTitle?: string }>;
}

function DueSoonSection() {
  const items = useDueSoon();
  const { selectList, toggleTaskExpanded } = useAppState();
  const [, setRefreshKey] = useState(0);

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
      <WorkingSection />
      <SuggestionSection />
      <DueSoonSection />
    </>
  );
}
