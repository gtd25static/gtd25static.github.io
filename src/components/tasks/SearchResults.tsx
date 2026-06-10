import { useSearch, type SearchResult } from '../../hooks/use-search';
import { useShallow } from 'zustand/react/shallow';
import { useAppState } from '../../stores/app-state';

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 text-inherit dark:bg-yellow-500/30 rounded-sm">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function isInactive(result: SearchResult) {
  if (result.type === 'list') return false;
  return result.status === 'done' || result.archived || result.parentTaskStatus === 'done';
}

function statusLabel(result: SearchResult): string {
  if (result.type === 'list') return result.listType === 'follow-ups' ? 'follow-up list' : 'task list';
  if (result.archived) return 'archived';
  return result.status;
}

function statusBadgeClass(result: SearchResult): string {
  if (result.type === 'list') return 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400';
  if (result.archived) return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
  switch (result.status) {
    case 'done': return 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400';
    case 'blocked': return 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400';
    default: return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
  }
}

function statusDot(result: SearchResult): string {
  if (result.type === 'list') return result.listType === 'follow-ups' ? 'bg-orange-500' : 'bg-blue-500';
  if (result.archived) return 'bg-zinc-300 dark:bg-zinc-600';
  switch (result.status) {
    case 'done': return 'bg-green-500';
    case 'blocked': return 'bg-red-500';
    default: return 'bg-zinc-300 dark:bg-zinc-600';
  }
}

function typeLabel(result: SearchResult): string {
  if (result.type === 'list') return 'list';
  if (result.type === 'task' && result.listType === 'follow-ups') return 'follow-up';
  return result.type;
}

function resultContext(result: SearchResult) {
  if (result.type === 'list') return result.listType === 'follow-ups' ? 'Follow-up list' : 'Task list';
  return result.listName;
}

function findFocusElement(id: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>('[data-focus-id]');
  return Array.from(nodes).find((node) => node.dataset.focusId === id) ?? null;
}

function ResultItem({ result, query, onNavigate }: { result: SearchResult; query: string; onNavigate: () => void }) {
  const inactive = isInactive(result);

  return (
    <button
      onClick={onNavigate}
      className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${
        inactive ? 'opacity-50' : ''
      }`}
    >
      <div className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusDot(result)}`} />
      <div className="min-w-0 flex-1">
        <div className={`text-sm ${
          inactive
            ? 'line-through text-zinc-400 dark:text-zinc-500'
            : 'text-zinc-800 dark:text-zinc-200'
        }`}>
          <HighlightedText text={result.title} query={query} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-400 dark:text-zinc-400">
          <span className="truncate">{resultContext(result)}</span>
          {result.type === 'subtask' && result.parentTaskTitle && (
            <>
              <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" className="shrink-0 opacity-50">
                <path d="M2 1l4 3-4 3z" />
              </svg>
              <span className="truncate">{result.parentTaskTitle}</span>
            </>
          )}
        </div>
      </div>
      <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeClass(result)}`}>
          {statusLabel(result)}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
          result.type === 'subtask'
            ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
            : result.type === 'list'
              ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
            : 'bg-accent-50 text-accent-600 dark:bg-accent-900/30 dark:text-accent-400'
        }`}>
          {typeLabel(result)}
        </span>
      </div>
    </button>
  );
}

export function SearchResults() {
  const { searchQuery, selectList, ensureTaskExpanded, setSearchQuery, setNavigateToTaskId, setFocusedItem, setFocusZone } = useAppState(useShallow(s => ({ searchQuery: s.searchQuery, selectList: s.selectList, ensureTaskExpanded: s.ensureTaskExpanded, setSearchQuery: s.setSearchQuery, setNavigateToTaskId: s.setNavigateToTaskId, setFocusedItem: s.setFocusedItem, setFocusZone: s.setFocusZone })));
  const { results, isSearching, maxReached } = useSearch(searchQuery);

  function scrollToResult(targetId: string, fallbackId?: string) {
    let attempts = 0;
    const tryScroll = () => {
      const el = findFocusElement(targetId) ?? (fallbackId ? findFocusElement(fallbackId) : null);
      if (el) {
        const focusedId = el.dataset.focusId ?? targetId;
        setFocusedItem(focusedId);
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      attempts++;
      if (attempts < 30) window.setTimeout(tryScroll, 50);
    };
    window.setTimeout(tryScroll, 0);
  }

  function handleNavigate(result: SearchResult) {
    if (result.type === 'list') {
      selectList(result.listId);
      setSearchQuery('');
      setFocusZone('sidebar');
      setFocusedItem(result.id);
      scrollToResult(result.id);
      return;
    }

    const taskId = result.type === 'subtask' ? result.parentTaskId! : result.id;
    const targetId = result.type === 'subtask' && result.listType === 'tasks' ? result.id : taskId;

    // Signal TaskListView / FollowUpList to reveal hidden sections before scrolling.
    setNavigateToTaskId(taskId);
    if (result.listType === 'tasks') ensureTaskExpanded(taskId);

    selectList(result.listId);
    setSearchQuery('');
    setFocusZone('main');
    setFocusedItem(targetId);
    scrollToResult(targetId, taskId);
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-3xl lg:max-w-4xl xl:max-w-5xl px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-normal text-zinc-800 dark:text-zinc-200">
              Search results
              <span className="ml-2 text-sm text-zinc-400">({results.length})</span>
            </h2>
          </div>

          {isSearching ? (
            <div className="flex items-center justify-center py-16 text-zinc-400">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2 animate-spin">
                <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
              </svg>
              <span className="text-sm">Searching...</span>
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-400">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 text-zinc-300 dark:text-zinc-500">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
              </svg>
              <p className="text-sm">No results for &ldquo;{searchQuery}&rdquo;</p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
                {results.map((r) => (
                  <ResultItem key={`${r.type}-${r.id}`} result={r} query={searchQuery} onNavigate={() => handleNavigate(r)} />
                ))}
              </div>
              {maxReached && (
                <p className="mt-3 text-center text-xs text-zinc-400 dark:text-zinc-500">
                  Showing first 50 results. Refine your search for more.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
