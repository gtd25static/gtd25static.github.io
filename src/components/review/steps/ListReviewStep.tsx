import type { Task, TaskList } from '../../../db/models';
import { setTaskStatus, deleteTask, restoreTask, updateTask } from '../../../hooks/use-tasks';
import { toggleWarning } from '../../../hooks/use-warning';
import { toast } from '../../ui/Toast';
import { ReviewStep } from '../ReviewStep';

interface ListEntry {
  list: TaskList;
  tasks: Task[];
  staleCount: number;
}

interface Props {
  lists: ListEntry[];
  listIndex: number;
  onNextList: () => void;
  onPrevList: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}

export function ListReviewStep({ lists, listIndex, onNextList, onPrevList, onNext, onPrev, onSkip }: Props) {
  if (lists.length === 0) {
    return (
      <ReviewStep title="Review Lists" subtitle="No task lists to review" count={0} onNext={onNext} onPrev={onPrev} onSkip={onSkip}>
        <div />
      </ReviewStep>
    );
  }

  const current = lists[listIndex];
  const isLastList = listIndex === lists.length - 1;
  const isFirstList = listIndex === 0;
  const staleDays = 7;

  function handleNext() {
    if (isLastList) onNext();
    else onNextList();
  }

  function handlePrevInner() {
    if (isFirstList) onPrev();
    else onPrevList();
  }

  return (
    <ReviewStep
      title={current.list.name}
      subtitle={`List ${listIndex + 1} of ${lists.length}${current.staleCount > 0 ? ` — ${current.staleCount} stale` : ''}`}
      count={current.tasks.length}
      onNext={handleNext}
      onPrev={handlePrevInner}
      onSkip={onSkip}
      nextLabel={isLastList ? 'Next' : 'Next List'}
    >
      <div className="space-y-1">
        {current.tasks.map((task) => {
          const isStale = task.updatedAt < Date.now() - staleDays * 24 * 60 * 60 * 1000;
          return (
            <div key={task.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${isStale ? 'border-amber-200 bg-amber-50/50 dark:border-amber-800/50 dark:bg-amber-900/10' : 'border-zinc-200 dark:border-zinc-700'}`}>
              <span className="flex-1 min-w-0 truncate text-sm text-zinc-800 dark:text-zinc-200">
                {task.title}
                {isStale && <span className="ml-1 text-xs text-amber-500">(stale)</span>}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setTaskStatus(task.id, 'done')}
                  className="rounded px-1.5 py-0.5 text-xs text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20"
                >
                  Done
                </button>
                <button
                  onClick={() => setTaskStatus(task.id, task.status === 'blocked' ? 'todo' : 'blocked')}
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {task.status === 'blocked' ? 'Unblock' : 'Block'}
                </button>
                <button
                  onClick={() => toggleWarning('task', task.id)}
                  className={`rounded px-1.5 py-0.5 text-xs ${task.hasWarning ? 'text-amber-500' : 'text-zinc-500'} hover:bg-zinc-100 dark:hover:bg-zinc-800`}
                >
                  {task.hasWarning ? 'Unwarn' : 'Warn'}
                </button>
                <button
                  onClick={() => { deleteTask(task.id); toast('Deleted', 'info', () => restoreTask(task.id)); }}
                  className="rounded px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  Del
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ReviewStep>
  );
}
