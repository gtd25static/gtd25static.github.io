import { useBlocked } from '../../hooks/use-blocked';
import { useAppState } from '../../stores/app-state';

export function BlockedBanner() {
  const items = useBlocked();
  const { selectList, toggleTaskExpanded, focusedItemId, focusZone } = useAppState();

  if (items.length === 0) return null;

  function handleClick(item: (typeof items)[0]) {
    selectList(item.listId);
    toggleTaskExpanded(item.id);
  }

  return (
    <div className="flex items-center gap-3 overflow-x-auto border-b border-zinc-100 px-5 py-1.5 dark:border-zinc-800">
      <span className="shrink-0 text-xs font-medium text-red-500 dark:text-red-400">Blocked</span>
      <div className="flex items-center gap-1.5">
        {items.slice(0, 5).map((item) => {
          const focused = focusedItemId === `banner-blocked-${item.id}` && focusZone === 'main';
          return (
            <button
              key={item.id}
              data-focus-id={`banner-blocked-${item.id}`}
              onClick={() => handleClick(item)}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                focused ? 'ring-2 ring-accent-500/40 dark:ring-accent-400/30' : ''
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="#ef4444" className="shrink-0">
                <path d="M8 1l7 13H1L8 1z" />
                <rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="white" />
                <circle cx="8" cy="12" r="0.9" fill="white" />
              </svg>
              <span className="max-w-[160px] truncate text-zinc-600 dark:text-zinc-300">
                {item.title}
              </span>
              {item.reason === 'subtask' && (
                <span className="text-red-400 dark:text-red-500">
                  {item.blockedSubtaskCount} sub
                </span>
              )}
            </button>
          );
        })}
        {items.length > 5 && (
          <span className="text-xs text-zinc-400">+{items.length - 5} more</span>
        )}
      </div>
    </div>
  );
}
