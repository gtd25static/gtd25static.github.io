import type { Task, Subtask } from '../../../db/models';
import { setTaskStatus, updateTask } from '../../../hooks/use-tasks';
import { setSubtaskStatus } from '../../../hooks/use-subtasks';
import { updateSubtask } from '../../../hooks/use-subtasks';
import { formatDate, daysUntil, toInputDate, fromInputDate } from '../../../lib/date-utils';
import { ReviewStep } from '../ReviewStep';

interface OverdueEntry {
  type: 'task' | 'subtask';
  item: Task | Subtask;
  parent?: Task;
}

interface Props {
  items: OverdueEntry[];
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}

export function OverdueStep({ items, onNext, onPrev, onSkip }: Props) {
  return (
    <ReviewStep title="Overdue & Due Soon" subtitle="Items past or approaching deadline" count={items.length} onNext={onNext} onPrev={onPrev} onSkip={onSkip}>
      <div className="space-y-1">
        {items.map((entry) => {
          const dueDate = entry.item.dueDate!;
          const days = daysUntil(dueDate);
          const isOverdue = days < 0;
          const isToday = days === 0;
          return (
            <div key={entry.item.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${isOverdue ? 'border-red-200 bg-red-50/50 dark:border-red-800/50 dark:bg-red-900/10' : 'border-zinc-200 dark:border-zinc-700'}`}>
              <div className="flex-1 min-w-0">
                <span className="truncate text-sm text-zinc-800 dark:text-zinc-200">{entry.item.title}</span>
                {entry.parent && (
                  <span className="ml-1 text-xs text-zinc-400">({entry.parent.title})</span>
                )}
                <span className={`ml-1 text-xs ${isOverdue ? 'text-red-500' : isToday ? 'text-orange-500' : 'text-zinc-400'}`}>
                  {isOverdue ? `Overdue ${formatDate(dueDate)}` : isToday ? 'Today' : formatDate(dueDate)}
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => {
                    if (entry.type === 'task') setTaskStatus(entry.item.id, 'done');
                    else setSubtaskStatus(entry.item.id, 'done');
                  }}
                  className="rounded px-1.5 py-0.5 text-xs text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20"
                >
                  Done
                </button>
                <input
                  type="date"
                  className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                  defaultValue={toInputDate(dueDate)}
                  onChange={(e) => {
                    const newDate = fromInputDate(e.target.value);
                    if (newDate) {
                      if (entry.type === 'task') updateTask(entry.item.id, { dueDate: newDate });
                      else updateSubtask(entry.item.id, { dueDate: newDate });
                    }
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </ReviewStep>
  );
}
