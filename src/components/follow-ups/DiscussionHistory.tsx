import { useState } from 'react';
import type { Task, DiscussionEntry } from '../../db/models';
import { Modal } from '../ui/Modal';
import { confirmDialog } from '../ui/ConfirmDialog';
import { updateTask } from '../../hooks/use-tasks';
import { newId } from '../../lib/id';

interface Props {
  task: Task;
  open: boolean;
  onClose: () => void;
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Local (not UTC) YYYY-MM-DD, so the date picker matches the user's calendar day.
function localISODate(d = new Date()): string {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().split('T')[0];
}

const PencilIcon = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
    <path d="M13.586 3.586a2 2 0 112.828 2.828L8 15.828l-3.771.943.943-3.771 8.414-8.414z" />
  </svg>
);

const TrashIcon = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6h12M8 6V4h4v2m-6 0v9a1 1 0 001 1h6a1 1 0 001-1V6M8.5 9v5M11.5 9v5" />
  </svg>
);

const sharedTextarea =
  'w-full resize-none rounded border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200';

/**
 * History of when a follow-up topic was discussed (newest first). Past notes are
 * shown compactly read-only; the pencil turns one into an editor (same form as
 * "add entry"), the trash deletes it (confirm-gated). The whole log is rewritten
 * and re-encrypted as a unit on save, so no special handling is needed.
 */
export function DiscussionHistory({ task, open, onClose }: Props) {
  const log = task.discussionLog ?? [];
  const entries = [...log].sort((a, b) => b.at - a.at);

  const [newNote, setNewNote] = useState('');
  const [newDate, setNewDate] = useState(localISODate());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

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
    let at = Date.now();
    if (newDate) {
      const [y, m, d] = newDate.split('-').map(Number);
      if (y && m && d) at = new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
    }
    const entry: DiscussionEntry = { id: newId(), at, ...(trimmed ? { note: trimmed } : {}) };
    await persist([...log, entry]);
    setNewNote('');
    setNewDate(localISODate());
  }

  return (
    <Modal open={open} onClose={onClose} title="Discussion history">
      <div className="space-y-4">
        {entries.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No discussions logged yet. Use “Discussed” after you raise this topic, or add one below.
          </p>
        ) : (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="group rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700/60 dark:bg-zinc-800/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    {formatWhen(entry.at)}
                  </div>
                  {editingId !== entry.id && (
                    <div className="-mt-1 flex shrink-0 items-center gap-1 text-zinc-400 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
                      <button
                        onClick={() => startEdit(entry)}
                        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg hover:bg-zinc-200 hover:text-accent-600 dark:hover:bg-zinc-700 dark:hover:text-accent-400 md:min-h-0 md:min-w-0 md:p-1.5"
                        title="Edit this entry"
                      >
                        <PencilIcon />
                      </button>
                      <button
                        onClick={() => removeEntry(entry)}
                        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg hover:bg-zinc-200 hover:text-red-600 dark:hover:bg-zinc-700 dark:hover:text-red-400 md:min-h-0 md:min-w-0 md:p-1.5"
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
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={2}
                      autoFocus
                      className={sharedTextarea}
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        onClick={() => setEditingId(null)}
                        className="min-h-[44px] rounded-lg px-4 text-sm font-medium text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-700 md:min-h-0 md:py-2"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => saveEdit(entry.id)}
                        className="min-h-[44px] rounded-lg bg-indigo-600 px-5 text-sm font-medium text-white hover:bg-indigo-700 md:min-h-0 md:py-2"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : entry.note ? (
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-300">
                    {entry.note}
                  </p>
                ) : (
                  <p className="mt-0.5 text-sm italic text-zinc-400 dark:text-zinc-500">No note</p>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-3 dark:border-zinc-600 dark:bg-zinc-900/40">
          <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Add an entry</div>
          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="What was discussed?"
            rows={2}
            className={`mb-2 ${sharedTextarea}`}
          />
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={newDate}
              max={localISODate()}
              onChange={(e) => setNewDate(e.target.value)}
              className="min-h-[44px] rounded-lg border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 md:min-h-0 md:py-2"
              title="When it was discussed (defaults to today)"
            />
            <button
              onClick={addEntry}
              disabled={!newNote.trim() && !newDate}
              className="ml-auto min-h-[44px] rounded-lg bg-indigo-600 px-5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40 md:min-h-0 md:py-2"
            >
              Add entry
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
