import type { Task } from '../../db/models';
import { Modal } from '../ui/Modal';

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

/** Read-only history of when a follow-up topic was discussed, newest first. */
export function DiscussionHistory({ task, open, onClose }: Props) {
  const entries = [...(task.discussionLog ?? [])].sort((a, b) => b.at - a.at);

  return (
    <Modal open={open} onClose={onClose} title="Discussion history">
      {entries.length === 0 ? (
        <p className="py-4 text-sm text-zinc-500 dark:text-zinc-400">
          No discussions logged yet. Use “Discussed” after you raise this topic to start a history.
        </p>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => (
            <li key={entry.id} className="border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {formatWhen(entry.at)}
              </div>
              {entry.note && (
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
                  {entry.note}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
