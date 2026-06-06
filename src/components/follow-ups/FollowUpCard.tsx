import { useState, useRef, useEffect, useCallback } from 'react';
import type { Task } from '../../db/models';
import { updateTask, deleteTask, restoreTask, moveTaskToList } from '../../hooks/use-tasks';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/ConfirmDialog';
import { useAppState } from '../../stores/app-state';
import { useShallow } from 'zustand/react/shallow';
import { isInCooldown, cooldownRemaining, formatCooldown, cadenceMs } from '../../hooks/use-follow-ups';
import { toggleWarning } from '../../hooks/use-warning';
import { useTaskLists } from '../../hooks/use-task-lists';
import { PingCooldownBadge } from './PingCooldownBadge';
import { DiscussedPopover } from './DiscussedPopover';
import { DiscussionHistory } from './DiscussionHistory';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { DropdownMenu } from '../ui/DropdownMenu';
import { formatDate, dueDateColor } from '../../lib/date-utils';
import { LinksList } from '../shared/LinksList';
import { TaskForm } from '../tasks/TaskForm';

function cadenceLabel(ms: number): string {
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  if (days >= 30) {
    const months = Math.round(days / 30);
    return `every ${months}mo`;
  }
  if (days >= 7 && days % 7 === 0) return `every ${days / 7}w`;
  if (days >= 1) return `every ${days}d`;
  return `every ${Math.round(ms / (60 * 60 * 1000))}h`;
}

// Action-chip layout: a 44px tap target on phones (per platform touch guidance),
// compact on md+ desktop. Colours are appended per chip.
const chipBase =
  'inline-flex shrink-0 items-center justify-center rounded-full px-3 text-xs font-medium min-h-[44px] md:min-h-0 md:px-2.5 md:py-1';

interface Props {
  task: Task;
  index?: number;
  dragHandleProps?: Record<string, unknown>;
}

export function FollowUpCard({ task, index, dragHandleProps }: Props) {
  const { focusedItemId, focusZone, editingItemId, setEditingItemId } = useAppState(useShallow(s => ({ focusedItemId: s.focusedItemId, focusZone: s.focusZone, editingItemId: s.editingItemId, setEditingItemId: s.setEditingItemId })));
  const focused = focusedItemId === task.id && focusZone === 'main';
  const [editing, setEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const inCooldown = isInCooldown(task);
  const lists = useTaskLists();
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showDiscussed, setShowDiscussed] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const discussedRef = useRef<HTMLDivElement>(null);

  // React to keyboard-triggered editing
  useEffect(() => {
    if (editingItemId === task.id && !editingTitle) {
      setEditedTitle(task.title);
      setEditingTitle(true);
    }
  }, [editingItemId, task.id, task.title]);

  // Close the "Discussed" popover on outside click
  useEffect(() => {
    if (!showDiscussed) return;
    function handleClick(e: MouseEvent) {
      if (discussedRef.current && !discussedRef.current.contains(e.target as Node)) {
        setShowDiscussed(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDiscussed]);

  async function handleResolve() {
    if (!await confirmDialog('Resolve this follow-up? It moves to the Resolved section and you can reopen it later.', { confirmLabel: 'Resolve' })) return;
    await updateTask(task.id, { archived: true });
  }

  async function handleReopen() {
    await updateTask(task.id, { archived: false });
  }

  async function handleUnsnooze() {
    await updateTask(task.id, {
      pingedAt: undefined,
      pingCooldown: undefined,
      pingCooldownCustomMs: undefined,
      pingCooldownUntil: undefined,
    });
  }

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  function buildContextMenuItems(): MenuItem[] {
    const otherLists = lists.filter((l) => l.id !== task.listId && l.type === 'follow-ups');
    const items: MenuItem[] = [
      { label: task.starred ? 'Unstar' : 'Star', onClick: () => updateTask(task.id, { starred: !task.starred }) },
      { label: task.hasWarning ? 'Clear warning' : 'Warn', onClick: () => toggleWarning('task', task.id) },
      { label: 'History', onClick: () => setShowHistory(true) },
    ];
    if (otherLists.length > 0) {
      items.push({
        label: 'Send to list',
        children: otherLists.map((l) => ({
          label: l.name,
          onClick: () => moveTaskToList(task.id, l.id),
        })),
      });
    }
    items.push(
      { label: 'Edit', onClick: () => setEditing(true) },
      { label: 'Delete', onClick: async () => {
        if (!await confirmDialog('Delete this follow-up?', { confirmLabel: 'Delete' })) return;
        deleteTask(task.id);
        toast('Follow-up deleted', 'info', () => restoreTask(task.id));
      }, danger: true },
    );
    return items;
  }

  return (
    <div data-focus-id={task.id} onContextMenu={handleContextMenu} className={`group mb-2 flex items-start gap-3 rounded-lg border px-3 py-3 shadow-sm transition-shadow hover:shadow-md ${
      focused
        ? 'border-accent-500 ring-2 ring-accent-500/40 dark:border-accent-400 dark:ring-accent-400/30'
        : 'border-zinc-200 dark:border-zinc-700/60'
    } ${inCooldown ? 'opacity-40' : ''} ${
      index !== undefined && index % 2 === 1 ? 'bg-zinc-50/70 dark:bg-zinc-800/30' : 'bg-white dark:bg-zinc-900/50'
    }`}>
      {/* Drag handle */}
      {dragHandleProps && (
        <div
          className="shrink-0 cursor-grab touch-none active:cursor-grabbing mt-0.5"
          {...dragHandleProps}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-zinc-300 dark:text-zinc-500">
            <circle cx="5.5" cy="4" r="1.2" />
            <circle cx="10.5" cy="4" r="1.2" />
            <circle cx="5.5" cy="8" r="1.2" />
            <circle cx="10.5" cy="8" r="1.2" />
            <circle cx="5.5" cy="12" r="1.2" />
            <circle cx="10.5" cy="12" r="1.2" />
          </svg>
        </div>
      )}

      <div className="flex-1 min-w-0">
        {task.hasWarning && (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="#f59e0b" className="inline-block mr-1 -mt-0.5">
            <path d="M8 1l7 13H1L8 1z" />
            <rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="white" />
            <circle cx="8" cy="12" r="0.9" fill="white" />
          </svg>
        )}
        {editingTitle ? (
          <input
            className="text-sm bg-transparent border-b border-accent-500 outline-none w-full"
            value={editedTitle}
            onChange={(e) => setEditedTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const trimmed = editedTitle.trim();
                if (trimmed && trimmed !== task.title) updateTask(task.id, { title: trimmed });
                setEditingTitle(false);
                if (editingItemId === task.id) setEditingItemId(null);
              } else if (e.key === 'Escape') {
                setEditingTitle(false);
                if (editingItemId === task.id) setEditingItemId(null);
              }
            }}
            onBlur={() => {
              const trimmed = editedTitle.trim();
              if (trimmed && trimmed !== task.title) updateTask(task.id, { title: trimmed });
              setEditingTitle(false);
              if (editingItemId === task.id) setEditingItemId(null);
            }}
            autoFocus
          />
        ) : (
          <span
            className="text-sm text-zinc-800 dark:text-zinc-200 line-clamp-3 hover:cursor-text"
            title="Double-click to edit"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditedTitle(task.title);
              setEditingTitle(true);
            }}
          >
            {task.title}
          </span>
        )}
        {task.description && (
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400 line-clamp-1">{task.description}</p>
        )}
        <div className="mt-1 flex items-center gap-2 flex-wrap">
          <PingCooldownBadge task={task} />
          {!task.archived && task.snoozeCadence && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" title="Default snooze cadence">
              {cadenceLabel(cadenceMs(task))}
            </span>
          )}
          {task.dueDate && (
            <span className={`text-xs font-medium ${dueDateColor(task.dueDate)}`}>
              {formatDate(task.dueDate)}
            </span>
          )}
          <LinksList primaryLink={task.link} primaryTitle={task.linkTitle} links={task.links} />
        </div>
      </div>

      {/* Unsnooze — one click to wake a snoozed follow-up early */}
      {!task.archived && inCooldown && (
        <button
          onClick={handleUnsnooze}
          className={`${chipBase} bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700`}
          title="Unsnooze — remove snooze"
        >
          Unsnooze · {formatCooldown(cooldownRemaining(task))} left
        </button>
      )}

      {/* Discussed button — log a discussion and re-snooze for the chosen cadence */}
      {!task.archived && (
        <div className="relative shrink-0" ref={discussedRef}>
          <button
            onClick={() => setShowDiscussed((v) => !v)}
            className={`${chipBase} bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 dark:hover:bg-emerald-800/40`}
            title="Log that you discussed this, then snooze for the chosen cadence"
          >
            Discussed
          </button>
          {showDiscussed && (
            <DiscussedPopover task={task} align="right" onDone={() => setShowDiscussed(false)} />
          )}
        </div>
      )}

      {/* History — shown when there's a discussion log to inspect/edit */}
      {(task.discussionLog?.length ?? 0) > 0 && (
        <button
          onClick={() => setShowHistory(true)}
          className={`${chipBase} bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700`}
          title="View and edit discussion history"
        >
          History
        </button>
      )}

      {/* Resolve / Unresolve — archive the follow-up (confirm-gated) or reopen it */}
      {task.archived ? (
        <button
          onClick={handleReopen}
          className={`${chipBase} bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-800/40`}
          title="Unresolve — move back to active"
        >
          Unresolve
        </button>
      ) : (
        <button
          onClick={handleResolve}
          className={`${chipBase} bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700`}
          title="Resolve — archive this follow-up"
        >
          Resolve
        </button>
      )}

      {/* Star button — always visible when starred */}
      <button
        onClick={() => updateTask(task.id, { starred: !task.starred })}
        className={`flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg md:min-h-0 md:min-w-0 md:p-0.5 ${task.starred ? 'text-amber-500' : 'text-zinc-300 hover:text-amber-400 dark:text-zinc-600 dark:hover:text-amber-400 md:opacity-0 md:group-hover:opacity-100'}`}
        title={task.starred ? 'Unstar' : 'Star'}
      >
        {task.starred ? (
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.39 6.34H19l-5.19 3.78 1.98 6.34L10 13.68l-5.79 3.78 1.98-6.34L1 7.34h6.61z" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 1l2.39 6.34H19l-5.19 3.78 1.98 6.34L10 13.68l-5.79 3.78 1.98-6.34L1 7.34h6.61z" /></svg>
        )}
      </button>
      {/* Hover actions: edit/delete */}
      <div className="flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 shrink-0">
        <DropdownMenu
          trigger={
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" className="text-zinc-400">
              <circle cx="10" cy="4" r="1.5" />
              <circle cx="10" cy="10" r="1.5" />
              <circle cx="10" cy="16" r="1.5" />
            </svg>
          }
          items={[
            { label: task.starred ? 'Unstar' : 'Star', onClick: () => updateTask(task.id, { starred: !task.starred }) },
            { label: task.hasWarning ? 'Clear warning' : 'Warn', onClick: () => toggleWarning('task', task.id) },
            { label: 'History', onClick: () => setShowHistory(true) },
            { label: 'Edit', onClick: () => setEditing(true) },
            { label: 'Delete', onClick: async () => {
              if (!await confirmDialog('Delete this follow-up?', { confirmLabel: 'Delete' })) return;
              deleteTask(task.id);
              toast('Follow-up deleted', 'info', () => restoreTask(task.id));
            }, danger: true },
          ]}
        />
      </div>

      {editing && (
        <TaskForm
          open={editing}
          onClose={() => setEditing(false)}
          initial={task}
          onSubmit={async (data) => {
            await updateTask(task.id, data);
            setEditing(false);
          }}
        />
      )}

      <DiscussionHistory task={task} open={showHistory} onClose={() => setShowHistory(false)} />

      {ctxMenu && (
        <ContextMenu
          position={ctxMenu}
          onClose={() => setCtxMenu(null)}
          items={buildContextMenuItems()}
        />
      )}
    </div>
  );
}
