import type { Task, Subtask } from '../../../db/models';
import { setTaskStatus } from '../../../hooks/use-tasks';
import { setSubtaskStatus } from '../../../hooks/use-subtasks';
import { ReviewStep } from '../ReviewStep';

interface BlockedEntry {
  task: Task;
  blockedSubtasks: Subtask[];
}

interface Props {
  items: BlockedEntry[];
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}

export function BlockedStep({ items, onNext, onPrev, onSkip }: Props) {
  return (
    <ReviewStep title="Blocked" subtitle="Tasks and subtasks that are blocked" count={items.length} onNext={onNext} onPrev={onPrev} onSkip={onSkip}>
      <div className="space-y-1">
        {items.map(({ task, blockedSubtasks }) => (
          <div key={task.id} className="rounded-lg border border-red-200 px-3 py-2 dark:border-red-800/50">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-sm text-zinc-800 dark:text-zinc-200">
                {task.title}
                {task.status === 'blocked' && <span className="ml-1 text-xs text-red-400">(blocked)</span>}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                {task.status === 'blocked' && (
                  <>
                    <button
                      onClick={() => setTaskStatus(task.id, 'todo')}
                      className="rounded px-1.5 py-0.5 text-xs text-accent-600 hover:bg-accent-50 dark:hover:bg-accent-900/20"
                    >
                      Unblock
                    </button>
                    <button
                      onClick={() => setTaskStatus(task.id, 'done')}
                      className="rounded px-1.5 py-0.5 text-xs text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20"
                    >
                      Done
                    </button>
                  </>
                )}
              </div>
            </div>
            {blockedSubtasks.length > 0 && (
              <div className="mt-1 ml-3 space-y-0.5">
                {blockedSubtasks.map((sub) => (
                  <div key={sub.id} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 min-w-0 truncate text-zinc-600 dark:text-zinc-400">{sub.title}</span>
                    <button
                      onClick={() => setSubtaskStatus(sub.id, 'todo')}
                      className="rounded px-1 py-0.5 text-accent-600 hover:bg-accent-50 dark:hover:bg-accent-900/20"
                    >
                      Unblock
                    </button>
                    <button
                      onClick={() => setSubtaskStatus(sub.id, 'done')}
                      className="rounded px-1 py-0.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20"
                    >
                      Done
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </ReviewStep>
  );
}
