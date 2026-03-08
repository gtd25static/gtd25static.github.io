import type { TaskStatus, SubtaskStatus } from '../../db/models';

const statusConfig: Record<string, { color: string; label: string }> = {
  todo: { color: 'bg-zinc-300 dark:bg-zinc-600', label: 'To do' },
  done: { color: 'bg-green-500', label: 'Done' },
  blocked: { color: 'bg-red-500', label: 'Blocked' },
  working: { color: 'bg-accent-500', label: 'Working' },
};

interface Props {
  status: TaskStatus | SubtaskStatus;
  onClick?: () => void;
}

export function TaskStatusBadge({ status, onClick }: Props) {
  const config = statusConfig[status];
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
      title={`Status: ${config.label}`}
    >
      <span className={`h-2 w-2 rounded-full ${config.color}`} />
      <span className="text-zinc-500 dark:text-zinc-300">{config.label}</span>
    </button>
  );
}
