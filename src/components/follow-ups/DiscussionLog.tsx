import { useState } from 'react';
import type { Task, DiscussionEntry } from '../../db/models';
import { confirmDialog } from '../ui/ConfirmDialog';
import { updateTask } from '../../hooks/use-tasks';
import { newId } from '../../lib/id';
import { splitBareUrls } from '../../lib/link-utils';

interface Props {
  task: Task;
}

// Entries shown before "Show more".
const RECENT_COUNT = 2;

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const PencilIcon = () => (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
    <path d="M13.586 3.586a2 2 0 112.828 2.828L8 15.828l-3.771.943.943-3.771 8.414-8.414z" />
  </svg>
);

const TrashIcon = () => (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6h12M8 6V4h4v2m-6 0v9a1 1 0 001 1h6a1 1 0 001-1V6M8.5 9v5M11.5 9v5" />
  </svg>
);

// Longer URLs are shown cut with … (the link and its tooltip keep the whole URL).
const MAX_URL_TEXT = 50;

/** A note with its http(s) URLs as links that open in a new tab. */
function NoteText({ note }: { note: string }) {
  return (
    <>
      {splitBareUrls(note).map((part, i) =>
        'url' in part ? (
          <a
            key={i}
            href={part.url}
            target="_blank"
            rel="noopener noreferrer"
            title={part.url}
            className="text-accent-600 hover:underline dark:text-accent-400"
          >
            {part.url.length > MAX_URL_TEXT ? `${part.url.slice(0, MAX_URL_TEXT - 1)}…` : part.url}
          </a>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

const sharedTextarea =
  'w-full resize-none rounded border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200';

/**
 * The discussion log of a follow-up, shown inline under its card: a box to log
 * a new note (stamped now; logging never snoozes — that's the Discussed chip),
 * then the newest entries, the rest behind "Show more". The pencil turns an
 * entry into an editor, the trash deletes it (confirm-gated). The whole log is
 * rewritten and re-encrypted as a unit on save, so no special handling is needed.
 */
export function DiscussionLog({ task }: Props) {
  const log = task.discussionLog ?? [];
  // Newest first. Equal timestamps (older entries logged via the date picker were
  // all pinned to 12:00) fall back to insertion order, so the last one added wins.
  const entries = log
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.at - a.entry.at || b.index - a.index)
    .map(({ entry }) => entry);

  const [newNote, setNewNote] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const shown = showAll ? entries : entries.slice(0, RECENT_COUNT);
  const hiddenCount = entries.length - shown.length;

  // Persist the log oldest-first to match how it's stored elsewhere.
  function persist(next: DiscussionEntry[]) {
    const sorted = [...next].sort((a, b) => a.at - b.at);
    return updateTask(task.id, { discussionLog: sorted });
  }

  function startEdit(entry: DiscussionEntry) {
    setEditingId(entry.id);
    setEditText(entry.note ?? '');
  }

  async function saveEdit(id: string) {
    const trimmed = editText.trim();
    const next = log.map((e) =>
      e.id === id ? { ...e, ...(trimmed ? { note: trimmed } : { note: undefined }) } : e,
    );
    setEditingId(null);
    await persist(next);
  }

  async function removeEntry(entry: DiscussionEntry) {
    if (!(await confirmDialog('Delete this discussion entry?', { confirmLabel: 'Delete' }))) return;
    await persist(log.filter((e) => e.id !== entry.id));
  }

  async function addEntry() {
    const trimmed = newNote.trim();
    if (!trimmed) return;
    await persist([...log, { id: newId(), at: Date.now(), note: trimmed }]);
    setNewNote('');
  }

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <textarea
          data-redact
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addEntry(); } }}
          placeholder="What was discussed?"
          aria-label="New discussion note"
          rows={2}
          className={sharedTextarea}
        />
        <button
          onClick={addEntry}
          disabled={!newNote.trim()}
          title="Add the note to the discussion log (does not snooze)"
          className="min-h-[44px] shrink-0 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40 md:min-h-0 md:py-1.5"
        >
          Log
        </button>
      </div>

      {shown.length > 0 && (
        <ul className="space-y-1.5">
          {shown.map((entry) => (
            <li
              key={entry.id}
              className="group/entry rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 dark:border-zinc-700/60 dark:bg-zinc-800/40"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {formatWhen(entry.at)}
                </div>
                {editingId !== entry.id && (
                  <div className="-my-1 flex shrink-0 items-center gap-1 text-zinc-400 md:opacity-0 md:transition-opacity md:group-hover/entry:opacity-100">
                    <button
                      onClick={() => startEdit(entry)}
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg hover:bg-zinc-200 hover:text-accent-600 dark:hover:bg-zinc-700 dark:hover:text-accent-400 md:min-h-0 md:min-w-0 md:p-1"
                      title="Edit this entry"
                    >
                      <PencilIcon />
                    </button>
                    <button
                      onClick={() => removeEntry(entry)}
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg hover:bg-zinc-200 hover:text-red-600 dark:hover:bg-zinc-700 dark:hover:text-red-400 md:min-h-0 md:min-w-0 md:p-1"
                      title="Delete this entry"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                )}
              </div>

              {editingId === entry.id ? (
                <div className="mt-1.5">
                  <textarea
                    data-redact
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(entry.id); } }}
                    rows={2}
                    autoFocus
                    className={sharedTextarea}
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      onClick={() => setEditingId(null)}
                      className="min-h-[44px] rounded-lg px-4 text-sm font-medium text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-700 md:min-h-0 md:py-1.5"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => saveEdit(entry.id)}
                      className="min-h-[44px] rounded-lg bg-indigo-600 px-5 text-sm font-medium text-white hover:bg-indigo-700 md:min-h-0 md:py-1.5"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : entry.note ? (
                <p data-redact className="mt-0.5 whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-300">
                  <NoteText note={entry.note} />
                </p>
              ) : (
                <p className="mt-0.5 text-sm italic text-zinc-400 dark:text-zinc-500">No note</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {entries.length > RECENT_COUNT && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="min-h-[44px] w-full rounded-lg text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 md:min-h-0 md:py-1"
        >
          {showAll ? 'Show less' : `Show more (${hiddenCount})`}
        </button>
      )}
    </div>
  );
}
