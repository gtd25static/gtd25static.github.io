import { useState } from 'react';
import type { Task, DiscussionEntry } from '../../db/models';
import { Modal } from '../ui/Modal';
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

/**
 * History of when a follow-up topic was discussed (newest first). Past notes can
 * be edited in place and new entries added — the whole log is rewritten and
 * re-encrypted as a unit on save, so no special handling is needed.
 */
export function DiscussionHistory({ task, open, onClose }: Props) {
  const log = task.discussionLog ?? [];
  const entries = [...log].sort((a, b) => b.at - a.at);

  const [newNote, setNewNote] = useState('');
  const [newDate, setNewDate] = useState('');

  // Persist the log oldest-first to match how it's stored elsewhere.
  function persist(next: DiscussionEntry[]) {
    const sorted = [...next].sort((a, b) => a.at - b.at);
    return updateTask(task.id, { discussionLog: sorted });
  }

  async function saveNote(id: string, note: string) {
    const trimmed = note.trim();
    const next = log.map((e) =>
      e.id === id ? { ...e, ...(trimmed ? { note: trimmed } : { note: undefined }) } : e,
    );
    await persist(next);
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
    setNewDate('');
  }

  return (
    <Modal open={open} onClose={onClose} title="Discussion history">
      <div className="space-y-4">
        {entries.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No discussions logged yet. Use “Discussed” after you raise this topic, or add one below.
          </p>
        ) : (
          <ul className="space-y-3">
            {entries.map((entry) => (
              <li key={entry.id} className="border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
                <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {formatWhen(entry.at)}
                </div>
                <textarea
                  defaultValue={entry.note ?? ''}
                  placeholder="Add a note…"
                  rows={2}
                  onBlur={(e) => {
                    if ((e.target.value.trim() || '') !== (entry.note ?? '')) {
                      void saveNote(entry.id, e.target.value);
                    }
                  }}
                  className="mt-1 w-full resize-none rounded border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-700 outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                />
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-zinc-200 pt-3 dark:border-zinc-700">
          <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Add an entry</div>
          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="What was discussed?"
            rows={2}
            className="mb-2 w-full resize-none rounded border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          />
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={newDate}
              max={new Date().toISOString().split('T')[0]}
              onChange={(e) => setNewDate(e.target.value)}
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              title="When it was discussed (defaults to now)"
            />
            <button
              onClick={addEntry}
              disabled={!newNote.trim() && !newDate}
              className="ml-auto rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              Add entry
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
