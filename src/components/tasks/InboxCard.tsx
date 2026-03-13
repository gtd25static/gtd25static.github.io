import type { Task } from '../../db/models';
import { deleteTask, restoreTask, moveTaskToList } from '../../hooks/use-tasks';
import { useTaskLists } from '../../hooks/use-task-lists';
import { toast } from '../ui/Toast';
import { DropdownMenu } from '../ui/DropdownMenu';
import { isInboxList } from '../../lib/constants';

interface Props {
  task: Task;
  index: number;
}

export function InboxCard({ task, index }: Props) {
  const lists = useTaskLists();
  const targetLists = lists.filter((l) => !isInboxList(l));

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData('application/x-inbox-task', task.id);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDelete() {
    deleteTask(task.id);
    toast('Task deleted', 'info', () => restoreTask(task.id));
  }

  function handleMoveTo(listId: string) {
    const target = lists.find((l) => l.id === listId);
    moveTaskToList(task.id, listId);
    toast(`Moved to ${target?.name ?? 'list'}`, 'success');
  }

  return (
    <div
      draggable="true"
      onDragStart={handleDragStart}
      className={`group mb-1.5 flex items-center gap-2 rounded-lg border border-zinc-200 px-2 py-3 md:py-2 shadow-sm cursor-grab active:cursor-grabbing transition-shadow hover:shadow-md dark:border-zinc-700/60 ${
        index % 2 === 1 ? 'bg-zinc-50/70 dark:bg-zinc-800/30' : 'bg-white dark:bg-zinc-900/50'
      }`}
    >
      {/* Drag handle */}
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-zinc-300 dark:text-zinc-500">
        <circle cx="5" cy="3" r="1.5" />
        <circle cx="11" cy="3" r="1.5" />
        <circle cx="5" cy="8" r="1.5" />
        <circle cx="11" cy="8" r="1.5" />
        <circle cx="5" cy="13" r="1.5" />
        <circle cx="11" cy="13" r="1.5" />
      </svg>

      {/* Title */}
      <span className="flex-1 min-w-0 text-sm text-zinc-800 dark:text-zinc-200 truncate">
        {task.title}
      </span>

      {/* Mobile: "Process to..." dropdown */}
      <div className="md:hidden shrink-0">
        <DropdownMenu
          trigger={
            <span className="rounded px-2 py-1 text-xs font-medium text-accent-600 bg-accent-50 dark:text-accent-400 dark:bg-accent-900/30">
              Process
            </span>
          }
          items={targetLists.map((l) => ({
            label: l.name,
            onClick: () => handleMoveTo(l.id),
          }))}
        />
      </div>

      {/* Delete button */}
      <button
        onClick={handleDelete}
        className="shrink-0 rounded p-1 text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 md:opacity-0 md:group-hover:opacity-100"
        aria-label="Delete"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
