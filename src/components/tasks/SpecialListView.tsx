import { useSpecialListContext, type SpecialItem } from '../../hooks/use-special-list';
import { useShallow } from 'zustand/react/shallow';
import { useAppState } from '../../stores/app-state';
import { setTaskStatus } from '../../hooks/use-tasks';
import { setSubtaskStatus } from '../../hooks/use-subtasks';
import { toggleWarning } from '../../hooks/use-warning';
import { startWorkingOn, startWorkingOnTask } from '../../hooks/use-working-on';

function timeSince(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function SpecialItemRow({ item }: { item: SpecialItem }) {
  const { selectList, toggleTaskExpanded } = useAppState(useShallow(s => ({ selectList: s.selectList, toggleTaskExpanded: s.toggleTaskExpanded })));

  function navigateToSource() {
    selectList(item.listId);
    const taskId = item.entityType === 'task' ? item.id : item.taskId;
    if (taskId) toggleTaskExpanded(taskId);
  }

  function handleDone(e: React.MouseEvent) {
    e.stopPropagation();
    if (item.entityType === 'task') {
      setTaskStatus(item.id, 'done');
    } else {
      setSubtaskStatus(item.id, 'done');
    }
  }

  function handleUnblock(e: React.MouseEvent) {
    e.stopPropagation();
    if (item.entityType === 'task') {
      setTaskStatus(item.id, 'todo');
    } else {
      setSubtaskStatus(item.id, 'todo');
    }
  }

  function handleRemoveWarning(e: React.MouseEvent) {
    e.stopPropagation();
    toggleWarning(item.entityType, item.id);
  }

  function handleWork(e: React.MouseEvent) {
    e.stopPropagation();
    if (item.entityType === 'task') {
      startWorkingOnTask(item.id);
    } else {
      startWorkingOn(item.id);
    }
  }

  return (
    <div className="group flex items-center gap-2 rounded-lg px-3 py-3 md:py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <button onClick={navigateToSource} className="flex-1 min-w-0 text-left">
        <span className="text-sm text-zinc-800 dark:text-zinc-200">{item.title}</span>
        {item.parentTitle && (
          <span className="ml-1.5 text-xs text-zinc-400 dark:text-zinc-500">
            in {item.parentTitle}
          </span>
        )}
        <span className="ml-2 text-xs text-zinc-400">{timeSince(item.stateDate)}</span>
      </button>
      <div className="flex items-center gap-1 shrink-0">
        {item.type === 'warning' && (
          <>
            <button
              onClick={handleRemoveWarning}
              className="rounded px-3 py-1.5 md:px-2 md:py-0.5 text-sm md:text-xs text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/20"
            >
              Clear
            </button>
            <button
              onClick={handleDone}
              className="rounded px-3 py-1.5 md:px-2 md:py-0.5 text-sm md:text-xs text-accent-600 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-900/20"
            >
              Done
            </button>
          </>
        )}
        {item.type === 'blocked' && (
          <>
            <button
              onClick={handleUnblock}
              className="rounded px-3 py-1.5 md:px-2 md:py-0.5 text-sm md:text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
            >
              Unblock
            </button>
            <button
              onClick={handleDone}
              className="rounded px-3 py-1.5 md:px-2 md:py-0.5 text-sm md:text-xs text-accent-600 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-900/20"
            >
              Done
            </button>
          </>
        )}
        {item.type === 'recurring' && (
          <>
            <button
              onClick={handleDone}
              className="rounded px-3 py-1.5 md:px-2 md:py-0.5 text-sm md:text-xs text-accent-600 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-900/20"
            >
              Done
            </button>
            <button
              onClick={handleWork}
              className="rounded px-3 py-1.5 md:px-2 md:py-0.5 text-sm md:text-xs text-accent-600 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-900/20"
            >
              Work
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function SpecialListView() {
  const { items, warningCount, blockedCount, recurringCount } = useSpecialListContext();

  const warnings = items.filter((i) => i.type === 'warning');
  const blocked = items.filter((i) => i.type === 'blocked');
  const recurring = items.filter((i) => i.type === 'recurring');

  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
        No warnings, blocked items, or recurring tasks
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      {warningCount > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 px-3 pb-2">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="#f59e0b">
              <path d="M8 1l7 13H1L8 1z" />
              <rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="white" />
              <circle cx="8" cy="12" r="0.9" fill="white" />
            </svg>
            <span className="text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
              Warnings ({warningCount})
            </span>
          </div>
          {warnings.map((item) => (
            <SpecialItemRow key={`${item.entityType}-${item.id}-warning`} item={item} />
          ))}
        </div>
      )}

      {blockedCount > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 px-3 pb-2">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="#ef4444">
              <path d="M8 1l7 13H1L8 1z" />
              <rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="white" />
              <circle cx="8" cy="12" r="0.9" fill="white" />
            </svg>
            <span className="text-xs font-medium uppercase tracking-wide text-red-600 dark:text-red-400">
              Blocked ({blockedCount})
            </span>
          </div>
          {blocked.map((item) => (
            <SpecialItemRow key={`${item.entityType}-${item.id}-blocked`} item={item} />
          ))}
        </div>
      )}

      {recurringCount > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 px-3 pb-2">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#8b5cf6" strokeWidth="1.5">
              <path d="M1 8a7 7 0 0113.6-2.3M15 8a7 7 0 01-13.6 2.3" strokeLinecap="round" />
              <path d="M14.6 2v3.7h-3.7M1.4 14v-3.7h3.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-xs font-medium uppercase tracking-wide text-violet-600 dark:text-violet-400">
              Recurring ({recurringCount})
            </span>
          </div>
          {recurring.map((item) => (
            <SpecialItemRow key={`${item.entityType}-${item.id}-recurring`} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
