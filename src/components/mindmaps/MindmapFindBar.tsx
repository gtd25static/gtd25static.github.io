import type { RefObject } from 'react';
import { isBlankFilter, MAX_SAVED_SEARCH_LENGTH } from '../../lib/list-filter';

// The search inside an open map, floating over the canvas's top-right corner.
// The canvas does the matching and the highlighting; this is the box: type to
// search, Enter / Shift+Enter (or the arrows) step through the matches, Escape
// or × closes.
export function MindmapFindBar({ inputRef, query, onQueryChange, matchCount, current, onStep, onClose }: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  matchCount: number;
  /** Where the selected node sits among the matches, or -1. */
  current: number;
  onStep: (step: 1 | -1) => void;
  onClose: () => void;
}) {
  const status = isBlankFilter(query)
    ? ''
    : matchCount === 0
      ? 'No matches'
      : current >= 0 ? `${current + 1}/${matchCount}` : `${matchCount} found`;

  return (
    <div
      role="search"
      className="absolute right-3 top-3 flex items-center gap-0.5 rounded-xl border border-zinc-200 bg-white/90 p-1 shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-zinc-800/90"
    >
      <input
        ref={inputRef}
        type="text"
        enterKeyHint="search"
        data-redact
        value={query}
        maxLength={MAX_SAVED_SEARCH_LENGTH}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          // The canvas's own keys (Enter = new sibling, Delete, arrows…) must not fire from here.
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault(); // already here: not the browser's own find
            e.currentTarget.select();
          }
        }}
        placeholder="Search this map…"
        aria-label="Search this map"
        className="h-10 w-28 rounded-lg bg-transparent px-2 text-sm text-zinc-800 placeholder:text-zinc-400 focus:outline-none md:h-8 sm:w-44 dark:text-zinc-200 dark:placeholder:text-zinc-500"
      />
      <span aria-live="polite" className="min-w-[4.5rem] shrink-0 px-1 text-center text-xs tabular-nums text-zinc-400">
        {status}
      </span>
      <FindButton label="Previous match (Shift+Enter)" disabled={matchCount === 0} onClick={() => onStep(-1)}>
        <path d="M18 15l-6-6-6 6" />
      </FindButton>
      <FindButton label="Next match (Enter)" disabled={matchCount === 0} onClick={() => onStep(1)}>
        <path d="M6 9l6 6 6-6" />
      </FindButton>
      <FindButton label="Close search (Esc)" onClick={onClose}>
        <path d="M6 6l12 12M18 6L6 18" />
      </FindButton>
    </div>
  );
}

function FindButton({ label, disabled, onClick, children }: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent md:h-8 md:w-8 dark:text-zinc-300 dark:hover:bg-zinc-700"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}
