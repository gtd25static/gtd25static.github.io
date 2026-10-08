import { useState } from 'react';
import { useMergeSuggestions, type MergeSuggestionGroup } from '../../hooks/use-merge-suggestions';
import { markNotDuplicates } from '../../hooks/use-task-lists';
import type { ListType } from '../../db/models';
import { MergeModal } from './MergeModal';

interface Props {
  listId: string;
  listType: ListType;
}

/**
 * "Arriba del todo" banner: surfaces near-duplicate groups within the current
 * list. "Review" opens a modal to merge them; "Not duplicates" keeps the group's
 * tasks apart for good (stored on the list, synced). A handled group is hidden
 * at once, before the live query catches up.
 */
export function MergeSuggestionsCard({ listId, listType }: Props) {
  const groups = useMergeSuggestions(listId, listType);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<MergeSuggestionGroup | null>(null);

  const dismiss = (signature: string) =>
    setDismissed((prev) => new Set(prev).add(signature));

  function notDuplicates(group: MergeSuggestionGroup) {
    dismiss(group.signature);
    void markNotDuplicates(listId, group.tasks.map((t) => t.id));
  }

  // Review stays open only while its group does: one of them completed on
  // another device, say, and the dialog would merge (and trash) stale entries —
  // or, left armed, pop up with them the next time any suggestion shows.
  if (active && !groups.some((g) => g.signature === active.signature)) setActive(null);

  const visible = groups.filter((g) => !dismissed.has(g.signature)).slice(0, 3);
  const modal = active && (
    <MergeModal
      key={active.signature}
      group={active}
      listType={listType}
      onClose={() => setActive(null)}
      onMerged={() => {
        dismiss(active.signature);
        setActive(null);
      }}
    />
  );
  if (visible.length === 0) return modal || null;

  return (
    <div className="mb-2 rounded-lg border border-accent-200 bg-accent-50/60 px-3 py-2 dark:border-accent-900/50 dark:bg-accent-900/15">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-accent-700 dark:text-accent-300">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="opacity-80">
          <path d="M5 3h6a1 1 0 011 1v1H4V4a1 1 0 011-1zM3 6h10l-.7 6.3A2 2 0 0110.3 14H5.7a2 2 0 01-2-1.7L3 6z" />
        </svg>
        Possible duplicates
      </div>
      <ul className="flex flex-col gap-1">
        {visible.map((g) => (
          <li key={g.signature} className="flex items-center gap-2 text-sm">
            <span data-redact className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-300">
              {g.tasks.map((t) => t.title || '(untitled)').join('  ·  ')}
            </span>
            <button
              type="button"
              onClick={() => setActive(g)}
              className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium text-accent-700 hover:bg-accent-100 dark:text-accent-300 dark:hover:bg-accent-900/40"
            >
              Review
            </button>
            <button
              type="button"
              onClick={() => notDuplicates(g)}
              title="Never suggest these together again"
              className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200"
            >
              Not duplicates
            </button>
          </li>
        ))}
      </ul>

      {modal}
    </div>
  );
}
