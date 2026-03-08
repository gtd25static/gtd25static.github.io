import { useWorkingOn, markWorkingDone, markWorkingBlocked, stopWorking } from '../../hooks/use-working-on';
import { useAppState } from '../../stores/app-state';

export function WorkingOnBanner() {
  const { task, subtask, isWorking } = useWorkingOn();
  const { selectList, toggleTaskExpanded, focusedItemId, focusZone, bannerFocusIndex } = useAppState();
  const focused = focusedItemId === 'banner-working' && focusZone === 'main';

  if (!isWorking || !task) return null;

  function navigateToTask() {
    if (!task) return;
    selectList(task.listId);
    toggleTaskExpanded(task.id);
  }

  const ring = 'ring-2 ring-accent-500/40 dark:ring-accent-400/30';

  return (
    <div data-focus-id="banner-working" className="flex items-center gap-2 border-b border-accent-100 bg-accent-50/60 px-5 py-1.5 dark:border-accent-800/40 dark:bg-accent-950/50">
      <button
        onClick={navigateToTask}
        className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs hover:bg-accent-100 dark:hover:bg-accent-900/40 ${focused && bannerFocusIndex === 0 ? ring : ''}`}
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
          className={`rounded-full bg-accent-600 px-3 py-1 text-xs font-semibold text-white hover:bg-accent-700 ${focused && bannerFocusIndex === 1 ? ring : ''}`}
        >Done</button>
        <button
          onClick={() => markWorkingBlocked()}
          className={`rounded-full px-2.5 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 ${focused && bannerFocusIndex === 2 ? ring : ''}`}
        >Blocked</button>
        <button
          onClick={() => stopWorking()}
          className={`rounded-full px-2.5 py-1 text-xs font-medium text-zinc-400 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 ${focused && bannerFocusIndex === 3 ? ring : ''}`}
        >Stop</button>
      </div>
    </div>
  );
}
