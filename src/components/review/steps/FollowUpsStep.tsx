import type { Task, TaskList } from '../../../db/models';
import { updateTask } from '../../../hooks/use-tasks';
import { isInCooldown, formatCooldown, cooldownRemaining } from '../../../hooks/use-follow-ups';
import { ReviewStep } from '../ReviewStep';

interface FollowUpEntry {
  list: TaskList;
  tasks: Task[];
}

interface Props {
  followUpLists: FollowUpEntry[];
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}

export function FollowUpsStep({ followUpLists, onNext, onPrev, onSkip }: Props) {
  const allTasks = followUpLists.flatMap((entry) =>
    entry.tasks.map((task) => ({ task, listName: entry.list.name }))
  );

  return (
    <ReviewStep title="Follow-ups" subtitle="Active follow-ups across all lists" count={allTasks.length} onNext={onNext} onPrev={onPrev} onSkip={onSkip}>
      <div className="space-y-1">
        {allTasks.map(({ task, listName }) => {
          const inCooldown = isInCooldown(task);
          const remaining = cooldownRemaining(task);
          return (
            <div key={task.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
              <div className="flex-1 min-w-0">
                <span className="truncate text-sm text-zinc-800 dark:text-zinc-200">{task.title}</span>
                <span className="ml-1 text-xs text-zinc-400">{listName}</span>
                {inCooldown && (
                  <span className="ml-1 text-xs text-orange-400">{formatCooldown(remaining)}</span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => {
                    if (inCooldown) {
                      updateTask(task.id, { pingedAt: undefined });
                    } else {
                      updateTask(task.id, { pingedAt: Date.now(), pingCooldown: task.pingCooldown ?? '12h' });
                    }
                  }}
                  className={`rounded px-1.5 py-0.5 text-xs ${inCooldown ? 'text-orange-500' : 'text-accent-600'} hover:bg-zinc-100 dark:hover:bg-zinc-800`}
                >
                  {inCooldown ? 'Clear' : 'Ping'}
                </button>
                <button
                  onClick={() => updateTask(task.id, { archived: true })}
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  Archive
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ReviewStep>
  );
}
