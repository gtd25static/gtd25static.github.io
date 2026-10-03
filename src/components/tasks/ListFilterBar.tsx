import { useLiveQuery } from 'dexie-react-hooks';
import { useShallow } from 'zustand/react/shallow';
import { db } from '../../db';
import { useAppState } from '../../stores/app-state';
import { saveListSearch, deleteListSearch } from '../../hooks/use-task-lists';
import { sanitizeSavedSearches, sameSearch, MAX_SAVED_SEARCHES, MAX_SAVED_SEARCH_LENGTH } from '../../lib/list-filter';
import { confirmDialog } from '../ui/ConfirmDialog';
import { toast } from '../ui/Toast';

const NO_SAVED_SEARCHES: string[] = [];

/**
 * The quick filter above a list: narrows it as you type (lib/list-filter.ts
 * says what matches) and keeps the searches you save as chips beside it — tap
 * one to filter by it again, tap it once more to clear.
 */
export function ListFilterBar({ listId }: { listId: string }) {
  const { query, setQuery } = useAppState(useShallow((s) => ({ query: s.listFilter, setQuery: s.setListFilter })));
  const saved = useLiveQuery(
    async () => sanitizeSavedSearches((await db.taskLists.get(listId))?.savedSearches),
    [listId],
  ) ?? NO_SAVED_SEARCHES;
  const search = query.trim();
  const canSave = search !== '' && !saved.some((s) => sameSearch(s, search));

  async function handleSave() {
    if (saved.length >= MAX_SAVED_SEARCHES) {
      toast(`A list keeps up to ${MAX_SAVED_SEARCHES} saved searches — delete one first`, 'info');
      return;
    }
    await saveListSearch(listId, search);
  }

  async function handleDelete(savedSearch: string) {
    if (!(await confirmDialog(`Delete the saved search “${savedSearch}”?`, { confirmLabel: 'Delete', danger: true }))) return;
    await deleteListSearch(listId, savedSearch);
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <div className="relative w-44 sm:w-56">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          enterKeyHint="search"
          data-redact
          value={query}
          maxLength={MAX_SAVED_SEARCH_LENGTH}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
            // Enter leaves the field, so j/k move through what's left (and a phone's keyboard closes).
            if (e.key === 'Escape' || e.key === 'Enter') e.currentTarget.blur();
          }}
          placeholder="Filter…"
          aria-label="Filter this list"
          className="h-8 w-full rounded-full border border-transparent bg-zinc-100 pl-7 pr-7 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-accent-500 focus:bg-white focus:outline-none md:h-7 dark:bg-zinc-800 dark:text-zinc-200 dark:placeholder:text-zinc-500 dark:focus:bg-zinc-900"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear filter"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        )}
      </div>

      {canSave && (
        <button
          type="button"
          onClick={handleSave}
          className="flex h-8 items-center gap-1 rounded-full px-2.5 text-sm text-accent-600 hover:bg-accent-50 md:h-6 md:text-xs dark:text-accent-400 dark:hover:bg-accent-900/20"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 2h8v12l-4-3-4 3z" strokeLinejoin="round" />
          </svg>
          Save search
        </button>
      )}

      {saved.map((savedSearch) => {
        const active = sameSearch(savedSearch, query);
        return (
          <span
            key={savedSearch}
            className={`flex h-8 items-center rounded-full text-sm md:h-6 md:text-xs ${
              active
                ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300'
                : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
            }`}
          >
            <button
              type="button"
              aria-pressed={active}
              onClick={() => setQuery(active ? '' : savedSearch)}
              className="h-full max-w-[10rem] truncate pl-3 pr-1 md:pl-2.5"
            >
              <span data-redact>{savedSearch}</span>
            </button>
            <button
              type="button"
              onClick={() => handleDelete(savedSearch)}
              aria-label={`Delete saved search “${savedSearch}”`}
              className="flex h-full items-center rounded-r-full pl-1 pr-2.5 opacity-60 hover:opacity-100 md:pr-2"
            >
              <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </span>
        );
      })}
    </div>
  );
}
