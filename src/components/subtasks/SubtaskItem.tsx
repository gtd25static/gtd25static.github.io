import { useState, useCallback, useEffect } from 'react';
import type { Subtask } from '../../db/models';
import { setSubtaskStatus, deleteSubtask, restoreSubtask, updateSubtask, convertSubtaskToTask } from '../../hooks/use-subtasks';
import { toast } from '../ui/Toast';
import { startWorkingOn } from '../../hooks/use-working-on';
import { toggleWarning } from '../../hooks/use-warning';
import { useTaskLists } from '../../hooks/use-task-lists';
import { useAppState } from '../../stores/app-state';
import { SubtaskForm } from './SubtaskForm';
import { formatDate, dueDateColor } from '../../lib/date-utils';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { DropdownMenu } from '../ui/DropdownMenu';
import { LinksList } from '../shared/LinksList';

interface Props {
  subtask: Subtask;
}

export function SubtaskItem({ subtask }: Props) {
  const lists = useTaskLists();
  const { focusedItemId, focusZone, editingItemId, setEditingItemId } = useAppState();
  const focused = focusedItemId === subtask.id && focusZone === 'main';
  const [editing, setEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  // React to keyboard-triggered editing
  useEffect(() => {
    if (editingItemId === subtask.id && !editingTitle) {
      setEditedTitle(subtask.title);
      setEditingTitle(true);
    }
  }, [editingItemId, subtask.id, subtask.title]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  function finishEditingTitle() {
    const trimmed = editedTitle.trim();
    if (trimmed && trimmed !== subtask.title) updateSubtask(subtask.id, { title: trimmed });
    setEditingTitle(false);
    if (editingItemId === subtask.id) setEditingItemId(null);
  }

  if (editing) {
    return (
      <SubtaskForm
        initial={subtask}
        onSubmit={async (data) => {
          await updateSubtask(subtask.id, data);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div
      data-focus-id={subtask.id}
      onContextMenu={handleContextMenu}
      className={`group flex items-center gap-2 rounded-md px-2 py-2.5 md:py-1 ${
        focused
          ? 'ring-2 ring-accent-500/40 dark:ring-accent-400/30'
          : ''
      } ${
        subtask.status === 'working' ? 'bg-accent-50 dark:bg-accent-950/30' : ''
      } ${subtask.status === 'done' ? 'opacity-50' : ''}`}
    >
      <div className="flex-1 min-w-0">
        {editingTitle ? (
          <input
            className="text-sm bg-transparent border-b border-accent-500 outline-none w-full"
            value={editedTitle}
            onChange={(e) => setEditedTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                finishEditingTitle();
              } else if (e.key === 'Escape') {
                setEditingTitle(false);
                if (editingItemId === subtask.id) setEditingItemId(null);
              }
            }}
            onBlur={finishEditingTitle}
            autoFocus
          />
        ) : (
          <span
            className={`text-sm ${subtask.status === 'done' ? 'line-through text-zinc-400' : ''}`}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditedTitle(subtask.title);
              setEditingTitle(true);
            }}
          >
            {subtask.title}
          </span>
        )}
        <div className="flex items-center gap-2">
          {subtask.hasWarning && (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="#f59e0b" className="shrink-0">
              <path d="M8 1l7 13H1L8 1z" />
              <rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="white" />
              <circle cx="8" cy="12" r="0.9" fill="white" />
            </svg>
          )}
          {subtask.dueDate && (
            <span className={`text-xs ${dueDateColor(subtask.dueDate)}`}>{formatDate(subtask.dueDate)}</span>
          )}
          <LinksList primaryLink={subtask.link} primaryTitle={subtask.linkTitle} links={subtask.links} />
        </div>
      </div>

      {subtask.status !== 'working' && subtask.status !== 'done' && (
        <button
          onClick={() => startWorkingOn(subtask.id)}
          className="rounded-full px-2.5 py-1.5 md:py-1 text-sm md:text-xs font-medium bg-accent-50 text-accent-600 hover:bg-accent-100 dark:bg-accent-900/30 dark:text-accent-300 dark:hover:bg-accent-800/40"
          title="Start working"
        >
          Work
        </button>
      )}
      {/* Mobile dropdown */}
      <div className="md:hidden shrink-0" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu
          trigger={
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" className="text-zinc-400">
              <circle cx="10" cy="4" r="1.5" />
              <circle cx="10" cy="10" r="1.5" />
              <circle cx="10" cy="16" r="1.5" />
            </svg>
          }
          items={[
            { label: subtask.status === 'blocked' ? 'Unblock' : 'Block', onClick: () => setSubtaskStatus(subtask.id, subtask.status === 'blocked' ? 'todo' : 'blocked') },
            { label: subtask.hasWarning ? 'Clear warning' : 'Warn', onClick: () => toggleWarning('subtask', subtask.id) },
            { label: 'Edit', onClick: () => setEditing(true) },
            { label: 'Delete', onClick: () => {
              if (!confirm('Delete this subtask?')) return;
              deleteSubtask(subtask.id);
              toast('Subtask deleted', 'info', () => restoreSubtask(subtask.id));
            }, danger: true },
          ]}
        />
      </div>
      {/* Desktop inline actions */}
      <div className="hidden md:flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100">
        <button
          onClick={() => setSubtaskStatus(subtask.id, subtask.status === 'blocked' ? 'todo' : 'blocked')}
          className={`rounded px-1.5 py-0.5 text-xs ${subtask.status === 'blocked' ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20' : 'text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
          title={subtask.status === 'blocked' ? 'Unblock' : 'Mark blocked'}
        >
          {subtask.status === 'blocked' ? 'Unblock' : 'Block'}
        </button>
        <button
          onClick={() => toggleWarning('subtask', subtask.id)}
          className={`rounded px-1.5 py-0.5 text-xs ${subtask.hasWarning ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20' : 'text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
          title={subtask.hasWarning ? 'Clear warning' : 'Add warning'}
        >
          {subtask.hasWarning ? 'Unwarn' : 'Warn'}
        </button>
        <button
          onClick={() => setEditing(true)}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          Edit
        </button>
        <button
          onClick={() => {
            if (!confirm('Delete this subtask?')) return;
            deleteSubtask(subtask.id);
            toast('Subtask deleted', 'info', () => restoreSubtask(subtask.id));
          }}
          className="rounded px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30"
        >
          Del
        </button>
      </div>

      {ctxMenu && (
        <ContextMenu
          position={ctxMenu}
          onClose={() => setCtxMenu(null)}
          items={buildContextMenuItems()}
        />
      )}
    </div>
  );

  function buildContextMenuItems(): MenuItem[] {
    const targetLists = lists.filter((l) => l.type === 'tasks');
    const items: MenuItem[] = [];
    if (targetLists.length > 0) {
      items.push({
        label: 'Promote to task',
        children: targetLists.map((l) => ({
          label: l.name,
          onClick: () => convertSubtaskToTask(subtask.id, l.id),
        })),
      });
    }
    return items;
  }
}
