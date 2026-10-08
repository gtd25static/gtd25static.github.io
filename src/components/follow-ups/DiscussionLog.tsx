import { useState, useRef, useEffect } from 'react';
import type { Task, DiscussionEntry } from '../../db/models';
import { confirmDialog } from '../ui/ConfirmDialog';
import { editDiscussionLog } from '../../hooks/use-follow-ups';
import { useAppState } from '../../stores/app-state';
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

// White on the log's tinted panel, so the box reads as the place to write.
const sharedTextarea =
  'w-full resize-none rounded-md border border-accent-200 bg-white px-2 py-1 text-sm text-zinc-800 outline-none focus:border-accent-500 dark:border-accent-800/70 dark:bg-zinc-900 dark:text-zinc-100';

/**
 * The discussion log of a follow-up, shown inline under its card: a box to log
 * a new note (stamped now; logging never snoozes — that's the Discussed chip),
 * then the newest entries as a timeline, the rest behind "Show more". Drawn as
 * a timeline on its own tinted panel, not as boxes: boxed, the entries looked
 * like more follow-up cards. The pencil turns an entry into an editor, the
 * trash deletes it (confirm-gated). The whole log is rewritten and re-encrypted
 * as a unit on save. An unsent note is kept as a draft (app-state) until it is
 * logged, cleared, or the vault locks.
 */
export function DiscussionLog({ task }: Props) {
  const log = task.discussionLog ?? [];
  // Newest first. Equal timestamps (older entries logged via the date picker were
  // all pinned to 12:00) fall back to insertion order, so the last one added wins.
  const entries = log
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.at - a.entry.at || b.index - a.index)
    .map(({ entry }) => entry);

  const newNote = useAppState((s) => s.noteDrafts[task.id] ?? '');
  const setNoteDraft = useAppState((s) => s.setNoteDraft);
  const focusRequested = useAppState((s) => s.noteFocusTaskId === task.id);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [showAll, setShowAll] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const shown = showAll ? entries : entries.slice(0, RECENT_COUNT);
  const hiddenCount = entries.length - shown.length;

  useEffect(() => {
    if (!focusRequested) return;
    noteRef.current?.focus();
    useAppState.getState().setNoteFocusTaskId(null);
  }, [focusRequested]);

  function startEdit(entry: DiscussionEntry) {
    setEditingId(entry.id);
    setEditText(entry.note ?? '');
  }

  async function saveEdit(id: string) {
    const trimmed = editText.trim();
    setEditingId(null);
    await editDiscussionLog(task.id, (current) =>
      current.map((e) => (e.id === id ? { ...e, ...(trimmed ? { note: trimmed } : { note: undefined }) } : e)),
    );
  }

  async function removeEntry(entry: DiscussionEntry) {
    if (!(await confirmDialog('Delete this discussion entry?', { confirmLabel: 'Delete' }))) return;
    await editDiscussionLog(task.id, (current) => current.filter((e) => e.id !== entry.id));
  }

  async function addEntry() {
    const trimmed = newNote.trim();
    if (!trimmed) return;
    setNoteDraft(task.id, '');
    await editDiscussionLog(task.id, (current) => [...current, { id: newId(), at: Date.now(), note: trimmed }]);
  }

  return (
    <div className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-accent-700 dark:text-accent-300">
        Discussion log{entries.length > 0 ? ` · ${entries.length}` : ''}
      </h3>
      <div className="flex items-end gap-2">
        <textarea
          ref={noteRef}
          data-redact
          value={newNote}
          onChange={(e) => setNoteDraft(task.id, e.target.value)}
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
        // A rail with a dot per entry, the newest one filled.
        <ol className="ml-1.5 space-y-3 border-l-2 border-accent-200 pl-4 dark:border-accent-800/70">
          {shown.map((entry, i) => (
            <li key={entry.id} className="group/entry relative">
              <span
                aria-hidden
                className={`absolute -left-[23px] top-1 h-3 w-3 rounded-full border-2 border-white dark:border-zinc-900 ${
                  i === 0 ? 'bg-accent-500' : 'bg-accent-300 dark:bg-accent-700'
                }`}
              />
              <div className="flex items-start justify-between gap-2">
                <time dateTime={new Date(entry.at).toISOString()} className="text-xs font-medium text-accent-700 dark:text-accent-300">
                  {formatWhen(entry.at)}
                </time>
                {editingId !== entry.id && (
                  <div className="-my-1 flex shrink-0 items-center gap-1 text-zinc-400 md:opacity-0 md:transition-opacity md:group-hover/entry:opacity-100 md:focus-within:opacity-100">
                    <button
                      onClick={() => startEdit(entry)}
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg hover:bg-accent-100 hover:text-accent-600 dark:hover:bg-accent-900/40 dark:hover:text-accent-400 md:min-h-0 md:min-w-0 md:p-1"
                      title="Edit this entry"
                    >
                      <PencilIcon />
                    </button>
                    <button
                      onClick={() => removeEntry(entry)}
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg hover:bg-accent-100 hover:text-red-600 dark:hover:bg-accent-900/40 dark:hover:text-red-400 md:min-h-0 md:min-w-0 md:p-1"
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
                      className="min-h-[44px] rounded-lg px-4 text-sm font-medium text-zinc-500 hover:bg-accent-100 dark:text-zinc-400 dark:hover:bg-accent-900/40 md:min-h-0 md:py-1.5"
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
                <p data-redact className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">
                  <NoteText note={entry.note} />
                </p>
              ) : (
                <p className="mt-0.5 text-sm italic text-zinc-400 dark:text-zinc-500">No note</p>
              )}
            </li>
          ))}
        </ol>
      )}

      {entries.length > RECENT_COUNT && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="min-h-[44px] rounded-lg px-2 text-xs font-medium text-accent-700 hover:bg-accent-100 dark:text-accent-300 dark:hover:bg-accent-900/40 md:min-h-0 md:py-1"
        >
          {showAll ? 'Show less' : `Show more (${hiddenCount})`}
        </button>
      )}
    </div>
  );
}
