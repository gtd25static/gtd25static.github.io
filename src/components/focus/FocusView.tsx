import { useState } from 'react';
import { useFocusSet, useFocusModeDaily, refillFocusNow } from '../../hooks/use-focus-mode';
import { setListExcludedFromFocus } from '../../hooks/use-task-lists';
import { recordError } from '../../lib/diagnostics';
import { MotivationBanner } from '../banners/MotivationBanner';
import { FocusTaskCard } from './FocusTaskCard';

/**
 * Focus Mode: the daily 2-3 task commitment view (default view on app open).
 * Tasks here can only be completed or deleted; a completed slot is held until
 * tomorrow, while slots lost any other way are topped up continuously. Once
 * the whole set is cleared, Refill picks a fresh one the same day. "Lists"
 * chooses which task lists Focus picks from (synced per list).
 */
export function FocusView() {
  const { members, completedTodayCount, candidateLists, state, revision } = useFocusSet();
  useFocusModeDaily(revision);
  const [listsOpen, setListsOpen] = useState(false);
  const leftOut = candidateLists.filter((l) => l.excludedFromFocus).length;

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-6 pb-24">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-5 flex items-start gap-3 px-1">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-medium text-zinc-800 dark:text-zinc-100">Focus</h1>
            <p className="text-sm text-zinc-400 dark:text-zinc-500">
              Just these — finish or delete. A finished task's slot refills tomorrow.
            </p>
          </div>
          {candidateLists.length > 0 && (
            <button
              onClick={() => setListsOpen((open) => !open)}
              aria-expanded={listsOpen}
              className="shrink-0 rounded-full px-3 py-2 md:py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              Lists{leftOut > 0 ? ` · ${candidateLists.length - leftOut}/${candidateLists.length}` : ''}
            </button>
          )}
        </div>

        {listsOpen && candidateLists.length > 0 && (
          <fieldset className="mb-5 rounded-xl border border-zinc-200 px-4 py-3 dark:border-zinc-700/60">
            <legend className="px-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Pick focus tasks from
            </legend>
            <div className="flex flex-col">
              {candidateLists.map((list) => (
                <label key={list.id} className="flex cursor-pointer items-center gap-2.5 py-2 md:py-1 text-sm text-zinc-700 dark:text-zinc-300">
                  <input
                    type="checkbox"
                    checked={!list.excludedFromFocus}
                    onChange={(e) => void setListExcludedFromFocus(list.id, !e.target.checked)}
                    className="shrink-0 rounded"
                  />
                  <span data-redact className="min-w-0 break-words">{list.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <MotivationBanner prominent />

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
              You're done here — see you tomorrow, or Refill for more.
            </p>
            <button
              onClick={() => void refillFocusNow().catch((e) => recordError('focus.refill', e))}
              className="mt-1 rounded-full bg-accent-600 px-4 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-accent-700"
            >
              Refill
            </button>
          </div>
        )}

        {state === 'all-clear' && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-zinc-200 px-6 py-12 text-center dark:border-zinc-700/60">
            <div className="text-base font-medium text-zinc-700 dark:text-zinc-300">
              Nothing to focus on
            </div>
            <p className="text-sm text-zinc-400 dark:text-zinc-500">
              {leftOut > 0
                ? 'No eligible tasks in the lists Focus picks from.'
                : 'All caught up — no eligible tasks anywhere.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
