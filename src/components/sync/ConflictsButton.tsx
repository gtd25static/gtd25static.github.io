import { useState } from 'react';
import { useConflicts } from '../../hooks/use-conflicts';
import { ConflictsDialog } from './ConflictsDialog';

/** Next to the sync indicator, only while there are conflicts to look at. */
export function ConflictsButton() {
  const conflicts = useConflicts();
  const [open, setOpen] = useState(false);
  if (conflicts.length === 0 && !open) return null;
  const count = conflicts.length;
  return (
    <>
      {count > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
          aria-label={`${count} sync conflict${count === 1 ? '' : 's'} — review`}
          title="Changed on two devices — review"
        >
          {count} conflict{count === 1 ? '' : 's'}
        </button>
      )}
      <ConflictsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
