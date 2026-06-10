import { useFocusSet, useFocusModeDaily } from '../../hooks/use-focus-mode';
import { FocusTaskCard } from './FocusTaskCard';

/**
 * Focus Mode: the daily 2-3 task commitment view (default view on app open).
 * Tasks here can only be completed or deleted; empty slots refill once per day.
 */
export function FocusView() {
  useFocusModeDaily();
  const { members, completedTodayCount, state } = useFocusSet();

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-5 px-1">
          <h1 className="text-lg font-medium text-zinc-800 dark:text-zinc-100">Focus</h1>
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            Just these — finish or delete. New tasks arrive tomorrow.
          </p>
        </div>

        {state === 'tasks' && (
          <div className="flex flex-col gap-3">
            {members.map((task) => (
              <FocusTaskCard key={task.id} task={task} />
            ))}
            {completedTodayCount > 0 && (
              <p className="px-1 text-center text-xs text-zinc-400 dark:text-zinc-500">
                {completedTodayCount} focus task{completedTodayCount > 1 ? 's' : ''} cleared today
              </p>
            )}
          </div>
        )}

        {state === 'all-done-today' && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-green-200 bg-green-50/50 px-6 py-12 text-center dark:border-green-900/40 dark:bg-green-900/10">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-500">
              <svg width="28" height="28" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6l2.5 3L9.5 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="text-base font-medium text-green-700 dark:text-green-400">
              Focus complete
            </div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {completedTodayCount > 0
                ? `You cleared ${completedTodayCount} focus task${completedTodayCount > 1 ? 's' : ''} today. `
                : ''}
              You're done here — see you tomorrow.
            </p>
          </div>
        )}

        {state === 'all-clear' && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-zinc-200 px-6 py-12 text-center dark:border-zinc-700/60">
            <div className="text-base font-medium text-zinc-700 dark:text-zinc-300">
              Nothing to focus on
            </div>
            <p className="text-sm text-zinc-400 dark:text-zinc-500">
              All caught up — no eligible tasks anywhere.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
