import { useReadyFollowUps } from '../../hooks/use-ready-follow-ups';
import { useAppState } from '../../stores/app-state';
import { useShallow } from 'zustand/react/shallow';

/**
 * Surfaces follow-up topics that are awake (not snoozed, not resolved) so they
 * don't slip between weekly reviews. Mirrors the DueSoonBanner pattern.
 */
export function FollowUpsReadyBanner() {
  const items = useReadyFollowUps();
  const { selectList } = useAppState(useShallow((s) => ({ selectList: s.selectList })));

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-3 overflow-x-auto border-b border-zinc-100 px-5 py-2.5 md:py-1.5 dark:border-zinc-800">
      <span className="shrink-0 text-sm md:text-xs font-medium text-zinc-400 dark:text-zinc-300 flex items-center gap-1">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="opacity-70">
          <path d="M8 1a5 5 0 00-5 5v2.6l-1.3 2.2A.7.7 0 002.3 12h11.4a.7.7 0 00.6-1.1L13 8.6V6a5 5 0 00-5-5zM6 13a2 2 0 004 0H6z" />
        </svg>
        Ready to discuss
      </span>
      <div className="flex items-center gap-1.5">
        {items.slice(0, 5).map((item) => (
          <button
            key={item.taskId}
            onClick={() => selectList(item.listId)}
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm md:text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title={item.listName}
          >
            <span className="max-w-[160px] truncate text-zinc-600 dark:text-zinc-300">{item.title}</span>
          </button>
        ))}
        {items.length > 5 && (
          <span className="text-xs text-zinc-400">+{items.length - 5} more</span>
        )}
      </div>
    </div>
  );
}
