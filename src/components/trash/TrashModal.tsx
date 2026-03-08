import { Modal } from '../ui/Modal';
import { useTrash, restoreFromTrash, permanentlyDelete, type TrashItem } from '../../hooks/use-trash';
import { useAppState } from '../../stores/app-state';

const typeLabels: Record<TrashItem['type'], string> = {
  list: 'List',
  task: 'Task',
  subtask: 'Subtask',
};

const typeBadgeColors: Record<TrashItem['type'], string> = {
  list: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  task: 'bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-300',
  subtask: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300',
};

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TrashModal() {
  const { trashOpen, setTrashOpen } = useAppState();

  if (!trashOpen) return null;

  return (
    <Modal open={trashOpen} onClose={() => setTrashOpen(false)} title="Trash">
      <TrashContent />
    </Modal>
  );
}

function TrashContent() {
  const items = useTrash();

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center py-8 text-zinc-400">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 text-zinc-300">
          <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
        </svg>
        <p className="text-sm">Trash is empty</p>
        <p className="text-xs text-zinc-400 mt-1">Deleted items are kept for 30 days</p>
      </div>
    );
  }

  return (
    <div className="space-y-1 max-h-[60vh] overflow-y-auto -mx-2 px-2">
      {items.map((item) => (
        <div
          key={`${item.type}-${item.id}`}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        >
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${typeBadgeColors[item.type]}`}>
            {typeLabels[item.type]}
          </span>
          <div className="flex-1 min-w-0">
            <span className="text-sm text-zinc-700 dark:text-zinc-200 truncate block">{item.title}</span>
            {item.parentTitle && (
              <span className="text-xs text-zinc-400 truncate block">in {item.parentTitle}</span>
            )}
          </div>
          <span className="shrink-0 text-[10px] text-zinc-400">{timeAgo(item.deletedAt)}</span>
          <button
            onClick={() => restoreFromTrash(item)}
            className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-accent-600 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-900/20"
          >
            Restore
          </button>
          <button
            onClick={() => {
              if (!confirm(`Permanently delete "${item.title}"? This cannot be undone.`)) return;
              permanentlyDelete(item);
            }}
            className="shrink-0 rounded px-2 py-0.5 text-xs text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
