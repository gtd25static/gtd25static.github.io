import type { Task } from '../../db/models';
import { setTaskStatus, deleteTask, restoreTask } from '../../hooks/use-tasks';
import { useSubtasks } from '../../hooks/use-subtasks';
import { focusTask, revealTask } from '../../hooks/use-focus';
import { dayDiff } from '../../lib/attention';
import { formatDate, daysUntil } from '../../lib/date-utils';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/ConfirmDialog';

/**
 * Focus Mode card. Clicking the card body — or "Start 25 min" — reveals the task
 * in its list (navigate + expand + highlight + centre-scroll); "Start 25 min" also
 * starts a Pomodoro. Complete and Delete stay in-place terminal actions.
 */
export function FocusTaskCard({ task }: { task: Task }) {
  const subtasks = useSubtasks(task.id);
  const doneSubtasks = subtasks.filter((s) => s.status === 'done').length;
  const now = Date.now();
  const focusDay = task.focusedAt != null ? dayDiff(task.focusedAt, now) + 1 : 1;
  const overdue = task.dueDate != null && daysUntil(task.dueDate) < 0;

  async function handleComplete() {
    await setTaskStatus(task.id, 'done');
    toast('Focus task completed', 'success', () => setTaskStatus(task.id, 'todo'));
  }

  async function handleDelete() {
    if (!(await confirmDialog('Delete this task?', { confirmLabel: 'Delete' }))) return;
    await deleteTask(task.id);
    toast('Task deleted', 'info', () => restoreTask(task.id));
  }

  return (
    <div
      data-redact
      onClick={() => revealTask(task.id, task.listId)}
      className="cursor-pointer rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-700/60 dark:bg-zinc-900/50 dark:hover:border-zinc-600"
    >
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="rounded-full bg-accent-50 px-2 py-0.5 font-medium text-accent-700 dark:bg-accent-900/20 dark:text-accent-300">
          Day {focusDay}
        </span>
        {task.dueDate != null && (
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${
              overdue
                ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
            }`}
          >
            {overdue ? 'Overdue' : 'Due'} {formatDate(task.dueDate)}
          </span>
        )}
        {subtasks.length > 0 && (
          <span className="ml-auto text-zinc-400 dark:text-zinc-500">
            {doneSubtasks}/{subtasks.length} subtasks
          </span>
        )}
      </div>

      <div className="text-base font-medium leading-6 text-zinc-800 dark:text-zinc-100">
        {task.title}
      </div>
      {task.description && (
        <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-sm text-zinc-500 dark:text-zinc-400">
          {task.description}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); handleComplete(); }}
          className="flex items-center gap-1.5 rounded-full bg-accent-600 px-4 py-2 md:py-1.5 text-sm font-medium text-white hover:bg-accent-700"
        >
          <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6l2.5 3L9.5 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Complete
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); focusTask(task.id, { startTimer: true }); }}
          className="rounded-full px-4 py-2 md:py-1.5 text-sm font-medium text-accent-600 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-900/20"
        >
          Start 25 min
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); handleDelete(); }}
          className="ml-auto rounded-full px-4 py-2 md:py-1.5 text-sm font-medium text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
