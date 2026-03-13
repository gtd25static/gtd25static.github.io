import type { Task } from '../../../db/models';
import { setTaskStatus, deleteTask, restoreTask, moveTaskToList } from '../../../hooks/use-tasks';
import { useTaskLists } from '../../../hooks/use-task-lists';
import { toast } from '../../ui/Toast';
import { ReviewStep } from '../ReviewStep';

interface Props {
  tasks: Task[];
  onNext: () => void;
  onSkip: () => void;
}

export function InboxStep({ tasks, onNext, onSkip }: Props) {
  const lists = useTaskLists();
  const taskLists = lists.filter((l) => l.type === 'tasks' && l.name !== 'Inbox');

  return (
    <ReviewStep title="Inbox" subtitle="Process unhandled items" count={tasks.length} onNext={onNext} onSkip={onSkip} isFirst>
      <div className="space-y-1">
        {tasks.map((task) => (
          <div key={task.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
            <span className="flex-1 min-w-0 truncate text-sm text-zinc-800 dark:text-zinc-200">{task.title}</span>
            <div className="flex items-center gap-1 shrink-0">
              {taskLists.length > 0 && (
                <select
                  className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      moveTaskToList(task.id, e.target.value);
                      toast('Moved', 'success');
                    }
                  }}
                >
                  <option value="" disabled>Move to...</option>
                  {taskLists.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              )}
              <button
                onClick={() => setTaskStatus(task.id, 'done')}
                className="rounded px-1.5 py-0.5 text-xs text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20"
              >
                Done
              </button>
              <button
                onClick={() => { deleteTask(task.id); toast('Deleted', 'info', () => restoreTask(task.id)); }}
                className="rounded px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                Del
              </button>
            </div>
          </div>
        ))}
      </div>
    </ReviewStep>
  );
}
