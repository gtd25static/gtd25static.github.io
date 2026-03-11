import { useDueSoon } from '../../hooks/use-due-soon';
import { daysUntil, dueDateColor } from '../../lib/date-utils';
import { startWorkingOn } from '../../hooks/use-working-on';
import { useAppState } from '../../stores/app-state';
import { useShallow } from 'zustand/react/shallow';
import { db } from '../../db';

export function DueSoonBanner() {
  const items = useDueSoon();
  const { selectList, toggleTaskExpanded } = useAppState(useShallow(s => ({ selectList: s.selectList, toggleTaskExpanded: s.toggleTaskExpanded })));

  if (items.length === 0) return null;

  async function handleClick(item: (typeof items)[0]) {
    if (item.type === 'task') {
      const task = await db.tasks.get(item.taskId);
      if (task) {
        selectList(task.listId);
        toggleTaskExpanded(task.id);
      }
    } else {
      const subtask = await db.subtasks.get(item.id);
      if (subtask) {
        const task = await db.tasks.get(subtask.taskId);
        if (task) {
          selectList(task.listId);
          toggleTaskExpanded(task.id);
        }
        await startWorkingOn(item.id);
      }
    }
  }

  return (
    <div className="flex items-center gap-3 overflow-x-auto border-b border-zinc-100 px-5 py-1.5 dark:border-zinc-800">
      <span className="shrink-0 text-xs font-medium text-zinc-400 dark:text-zinc-300">Due soon</span>
      <div className="flex items-center gap-1.5">
        {items.slice(0, 5).map((item) => {
          const days = daysUntil(item.dueDate);
          const label = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Today' : `${days}d`;
          return (
            <button
              key={item.id}
              onClick={() => handleClick(item)}
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className={`font-medium ${dueDateColor(item.dueDate)}`}>{label}</span>
              <span className="max-w-[120px] truncate text-zinc-500 dark:text-zinc-300">
                {item.parentTitle ? `${item.parentTitle} > ` : ''}{item.title}
              </span>
            </button>
          );
        })}
        {items.length > 5 && (
          <span className="text-xs text-zinc-400">+{items.length - 5} more</span>
        )}
      </div>
    </div>
  );
}
