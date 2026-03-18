import { useState, useCallback, useEffect, useRef } from 'react';
import type { Task } from '../../db/models';
import { formatDate, daysUntil, formatTimeRemaining } from '../../lib/date-utils';
import { setTaskStatus, deleteTask, restoreTask, updateTask, moveTaskToList, duplicateTask } from '../../hooks/use-tasks';
import { toast } from '../ui/Toast';
import { useShallow } from 'zustand/react/shallow';
import { useAppState } from '../../stores/app-state';
import { useSubtasks } from '../../hooks/use-subtasks';
import { useTaskLists } from '../../hooks/use-task-lists';
import { startWorkingOn, startWorkingOnTask } from '../../hooks/use-working-on';
import { toggleWarning } from '../../hooks/use-warning';
import { SubtaskJourney } from '../subtasks/SubtaskJourney';
import { TaskForm } from './TaskForm';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { DropdownMenu } from '../ui/DropdownMenu';
import { LinksList } from '../shared/LinksList';

interface Props {
  task: Task;
  index?: number;
  dragHandleProps?: Record<string, unknown>;
}

export function TaskCard({ task, index, dragHandleProps }: Props) {
  const { expandedTaskIds, toggleTaskExpanded, focusedItemId, focusZone, editingItemId, setEditingItemId, bulkMode, selectedTaskIds, toggleTaskSelected, setBulkMode } = useAppState(useShallow(s => ({ expandedTaskIds: s.expandedTaskIds, toggleTaskExpanded: s.toggleTaskExpanded, focusedItemId: s.focusedItemId, focusZone: s.focusZone, editingItemId: s.editingItemId, setEditingItemId: s.setEditingItemId, bulkMode: s.bulkMode, selectedTaskIds: s.selectedTaskIds, toggleTaskSelected: s.toggleTaskSelected, setBulkMode: s.setBulkMode })));
  const isSelected = selectedTaskIds.has(task.id);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleTouchStart() {
    if (bulkMode) return;
    longPressTimer.current = setTimeout(() => {
      setBulkMode(true);
      toggleTaskSelected(task.id);
    }, 500);
  }

  function handleTouchEnd() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }
  const subtasks = useSubtasks(task.id);
  const expanded = expandedTaskIds.has(task.id);
  const focused = focusedItemId === task.id && focusZone === 'main';
  const hasBlockedSubtask = subtasks.some((s) => s.status === 'blocked');
  const hasWorkingSubtask = subtasks.some((s) => s.status === 'working');
  const lists = useTaskLists();
  const [editing, setEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  // React to keyboard-triggered editing
  useEffect(() => {
    if (editingItemId === task.id && !editingTitle) {
      setEditedTitle(task.title);
      setEditingTitle(true);
    }
  }, [editingItemId, task.id, task.title]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  function handleCheck(e: React.MouseEvent) {
    e.stopPropagation();
    setTaskStatus(task.id, task.status === 'done' ? 'todo' : 'done');
  }

  function finishEditingTitle() {
    const trimmed = editedTitle.trim();
    if (trimmed && trimmed !== task.title) updateTask(task.id, { title: trimmed });
    setEditingTitle(false);
    if (editingItemId === task.id) setEditingItemId(null);
  }

  return (
    <div data-task-id={task.id} data-focus-id={task.id} className={`mb-1.5 rounded-lg ${focused ? 'relative z-10 ring-2 ring-accent-500 dark:ring-accent-400' : ''} ${bulkMode && isSelected ? 'ring-2 ring-accent-500/40' : ''}`} onContextMenu={bulkMode ? undefined : handleContextMenu} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchMove={handleTouchEnd}>
      <div
        className={`group flex items-center gap-2 rounded-t-lg px-2 py-3 md:py-1.5 cursor-pointer border transition-shadow ${
          focused
            ? 'border-accent-500/60 dark:border-accent-400/50'
            : 'border-zinc-200 dark:border-zinc-700/60'
        } ${
          expanded && !bulkMode ? 'rounded-b-none border-b-0 bg-zinc-100/80 dark:bg-zinc-800/60' : 'rounded-b-lg shadow-sm'
        } ${
          !expanded && !focused && (index !== undefined && index % 2 === 1
            ? 'bg-zinc-50/70 dark:bg-zinc-800/30'
            : 'bg-white dark:bg-zinc-900/50')
        } hover:shadow-md`}
        onClick={() => bulkMode ? toggleTaskSelected(task.id) : toggleTaskExpanded(task.id)}
      >
        {/* Expand/collapse chevron + drag handle (hidden in bulk mode) */}
        {!bulkMode && (
          <div
            className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
            {...dragHandleProps}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`text-zinc-300 transition-transform dark:text-zinc-500 ${expanded ? 'rotate-180' : ''}`}
            >
              <path d="M3 6l5 5 5-5z" />
            </svg>
          </div>
        )}

        {/* Selection checkbox in bulk mode / Square checkbox otherwise */}
        {bulkMode ? (
          <button
            onClick={(e) => { e.stopPropagation(); toggleTaskSelected(task.id); }}
            className="shrink-0 flex h-7 w-7 md:h-6 md:w-6 items-center justify-center rounded border-[1.5px] border-zinc-300 dark:border-zinc-600"
            aria-label={isSelected ? 'Deselect' : 'Select'}
          >
            {isSelected && (
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6l2.5 3L9.5 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-accent-600 dark:text-accent-400" />
              </svg>
            )}
          </button>
        ) : (
        <button
          onClick={handleCheck}
          className="shrink-0 flex items-center justify-center relative"
          aria-label={task.status === 'done' ? 'Mark incomplete' : 'Mark complete'}
        >
          {task.status === 'done' ? (
            <div className="flex h-7 w-7 md:h-6 md:w-6 items-center justify-center rounded bg-accent-500">
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6l2.5 3L9.5 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          ) : task.status === 'working' ? (
            <div className="flex h-7 w-7 md:h-6 md:w-6 items-center justify-center rounded border-[1.5px] border-accent-500 bg-accent-50 dark:bg-accent-950/30">
              <div className="h-2.5 w-2.5 rounded-sm bg-accent-500" />
            </div>
          ) : task.status === 'blocked' ? (
            <div className="flex h-7 w-7 md:h-6 md:w-6 items-center justify-center rounded border-[1.5px] border-red-400">
              <svg width="12" height="12" viewBox="0 0 10 10">
                <path d="M2.5 5h5" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          ) : hasWorkingSubtask ? (
            <div className="flex h-7 w-7 md:h-6 md:w-6 items-center justify-center rounded border-[1.5px] border-accent-500 bg-accent-50 dark:bg-accent-950/30">
              <span className="text-[10px] font-semibold leading-none text-accent-600 dark:text-accent-400">
                {subtasks.filter((s) => s.status === 'done').length}/{subtasks.length}
              </span>
            </div>
          ) : hasBlockedSubtask ? (
            <div className="flex h-7 w-7 md:h-6 md:w-6 items-center justify-center rounded border-[1.5px] border-red-400">
              <span className="text-[10px] font-semibold leading-none text-red-500 dark:text-red-400">
                {subtasks.filter((s) => s.status === 'done').length}/{subtasks.length}
              </span>
              {/* Warning mini-icon */}
              <svg width="8" height="8" viewBox="0 0 16 16" fill="#ef4444" className="absolute -top-1 -right-1">
                <path d="M8 1l7 13H1L8 1z" />
                <rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="white" />
                <circle cx="8" cy="12" r="0.9" fill="white" />
              </svg>
            </div>
          ) : subtasks.length > 0 ? (
            <div className="flex h-7 w-7 md:h-6 md:w-6 items-center justify-center rounded border-[1.5px] border-zinc-300 dark:border-zinc-600">
              <span className="text-[10px] font-semibold leading-none text-zinc-400 dark:text-zinc-500">
                {subtasks.filter((s) => s.status === 'done').length}/{subtasks.length}
              </span>
            </div>
          ) : (
            <div className="h-7 w-7 md:h-6 md:w-6 rounded border-[1.5px] border-zinc-300 hover:border-zinc-400 dark:border-zinc-600 dark:hover:border-zinc-500" />
          )}
        </button>
        )}

        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <input
              className="text-sm bg-transparent border-b border-accent-500 outline-none w-full"
              value={editedTitle}
              onChange={(e) => setEditedTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  finishEditingTitle();
                } else if (e.key === 'Escape') {
                  setEditingTitle(false);
                  if (editingItemId === task.id) setEditingItemId(null);
                }
              }}
              onBlur={finishEditingTitle}
              autoFocus
            />
          ) : (
            <span
              className={`text-sm leading-5 line-clamp-3 ${
                task.status === 'done'
                  ? 'line-through text-zinc-400 dark:text-zinc-500'
                  : 'text-zinc-800 dark:text-zinc-200'
              }`}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditedTitle(task.title);
                setEditingTitle(true);
              }}
            >
              {task.title}
            </span>
          )}

          {/* Metadata badges on separate row */}
          {(task.hasWarning || task.recurrenceType || (task.status !== 'done' && task.dueDate) || task.link || task.links?.length) && (
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              {task.hasWarning && (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="#f59e0b" className="shrink-0">
                  <path d="M8 1l7 13H1L8 1z" />
                  <rect x="7.2" y="6" width="1.6" height="4" rx="0.8" fill="white" />
                  <circle cx="8" cy="12" r="0.9" fill="white" />
                </svg>
              )}
              {task.recurrenceType && (
                <span className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-xs font-medium text-violet-600 bg-violet-50 dark:text-violet-400 dark:bg-violet-900/20 shrink-0">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-70">
                    <path d="M1 8a7 7 0 0113.6-2.3M15 8a7 7 0 01-13.6 2.3" strokeLinecap="round" />
                    <path d="M14.6 2v3.7h-3.7M1.4 14v-3.7h3.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {task.nextOccurrence ? formatTimeRemaining(task.nextOccurrence) : ''}
                </span>
              )}
              {task.status !== 'done' && task.dueDate && <DueDateBadge dueDate={task.dueDate} />}
              <LinksList primaryLink={task.link} primaryTitle={task.linkTitle} links={task.links} />
            </div>
          )}
        </div>

        {/* Mobile dropdown (hidden in bulk mode) */}
        {!bulkMode && <div className="md:hidden shrink-0" onClick={(e) => e.stopPropagation()}>
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
              ...(task.status !== 'working' && !hasWorkingSubtask && task.status !== 'done' ? [{
                label: 'Work', onClick: () => {
                  if (subtasks.length > 0) {
                    const firstUndone = subtasks.find((s) => s.status === 'todo' || s.status === 'blocked');
                    if (firstUndone) startWorkingOn(firstUndone.id);
                  } else {
                    startWorkingOnTask(task.id);
                  }
                },
              }] : []),
              { label: task.status === 'blocked' ? 'Unblock' : 'Block', onClick: () => setTaskStatus(task.id, task.status === 'blocked' ? 'todo' : 'blocked') },
              { label: task.hasWarning ? 'Clear warning' : 'Warn', onClick: () => toggleWarning('task', task.id) },
              { label: 'Edit', onClick: () => setEditing(true) },
              { label: 'Duplicate', onClick: async () => {
                const dup = await duplicateTask(task.id);
                if (dup) toast('Task duplicated', 'success');
              }},
              { label: 'Delete', onClick: () => {
                if (!confirm('Delete this task?')) return;
                deleteTask(task.id);
                toast('Task deleted', 'info', () => restoreTask(task.id));
              }, danger: true },
            ]}
          />
        </div>}
        {/* Desktop inline actions (hidden in bulk mode) */}
        {!bulkMode && <div className="hidden md:flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => updateTask(task.id, { starred: !task.starred })}
            className={`rounded px-1 py-0.5 text-xs ${task.starred ? 'text-amber-500' : 'text-zinc-300 hover:text-amber-400 dark:text-zinc-600 dark:hover:text-amber-400'}`}
            title={task.starred ? 'Unstar' : 'Star'}
          >
            {task.starred ? (
              <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.39 6.34H19l-5.19 3.78 1.98 6.34L10 13.68l-5.79 3.78 1.98-6.34L1 7.34h6.61z" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 1l2.39 6.34H19l-5.19 3.78 1.98 6.34L10 13.68l-5.79 3.78 1.98-6.34L1 7.34h6.61z" /></svg>
            )}
          </button>
          {task.status !== 'working' && !hasWorkingSubtask && task.status !== 'done' && (
            <button
              onClick={() => {
                if (subtasks.length > 0) {
                  const firstUndone = subtasks.find((s) => s.status === 'todo' || s.status === 'blocked');
                  if (firstUndone) startWorkingOn(firstUndone.id);
                } else {
                  startWorkingOnTask(task.id);
                }
              }}
              className="rounded-full px-2.5 py-0.5 text-xs font-medium bg-accent-50 text-accent-600 hover:bg-accent-100 dark:bg-accent-900/30 dark:text-accent-300 dark:hover:bg-accent-800/40"
              title="Start working"
            >
              Work
            </button>
          )}
          <button
            onClick={() => setTaskStatus(task.id, task.status === 'blocked' ? 'todo' : 'blocked')}
            className={`rounded px-1.5 py-0.5 text-xs ${task.status === 'blocked' ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20' : 'text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
            title={task.status === 'blocked' ? 'Unblock' : 'Mark blocked'}
          >
            {task.status === 'blocked' ? 'Unblock' : 'Block'}
          </button>
          <button
            onClick={() => toggleWarning('task', task.id)}
            className={`rounded px-1.5 py-0.5 text-xs ${task.hasWarning ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20' : 'text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
            title={task.hasWarning ? 'Clear warning' : 'Add warning'}
          >
            {task.hasWarning ? 'Unwarn' : 'Warn'}
          </button>
          <button
            onClick={() => setEditing(true)}
            className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Edit
          </button>
          <button
            onClick={async () => {
              const dup = await duplicateTask(task.id);
              if (dup) toast('Task duplicated', 'success');
            }}
            className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title="Duplicate task"
          >
            Dup
          </button>
          <button
            onClick={() => {
              if (!confirm('Delete this task?')) return;
              deleteTask(task.id);
              toast('Task deleted', 'info', () => restoreTask(task.id));
            }}
            className="rounded px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30"
          >
            Del
          </button>
        </div>}
      </div>

      {/* Expanded content (hidden in bulk mode) */}
      {expanded && !bulkMode && (
        <div className={`-mt-px rounded-b-lg border border-t-0 px-2 pb-2 pt-1 shadow-sm ${
          focused
            ? 'border-accent-500/60 dark:border-accent-400/50'
            : 'border-zinc-200 dark:border-zinc-700/60'
        } ${
          index !== undefined && index % 2 === 1 ? 'bg-zinc-50/70 dark:bg-zinc-800/30' : 'bg-white dark:bg-zinc-900/50'
        }`}>
          {task.description && (
            <p className="mb-1 text-sm text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap">{task.description}</p>
          )}
          <SubtaskJourney taskId={task.id} />
          {/* Collapse bar */}
          <button
            onClick={() => toggleTaskExpanded(task.id)}
            className="mt-1 flex w-full items-center justify-center gap-1 rounded py-1 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3 10l5-5 5 5z" />
            </svg>
            Collapse
          </button>
        </div>
      )}

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
    const otherLists = lists.filter((l) => l.id !== task.listId && l.type === 'tasks');
    const items: MenuItem[] = [
      { label: task.starred ? 'Unstar' : 'Star', onClick: () => updateTask(task.id, { starred: !task.starred }) },
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
    return items;
  }
}

function DueDateBadge({ dueDate }: { dueDate: number }) {
  const days = daysUntil(dueDate);
  const isOverdue = days < 0;
  const isToday = days === 0;
  const isTomorrow = days === 1;

  let label: string;
  if (isOverdue) label = formatDate(dueDate);
  else if (isToday) label = 'Today';
  else if (isTomorrow) label = 'Tomorrow';
  else label = formatDate(dueDate);

  const colorClass = isOverdue || isToday
    ? 'text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-900/20'
    : isTomorrow
      ? 'text-orange-600 bg-orange-50 dark:text-orange-400 dark:bg-orange-900/20'
      : 'text-zinc-500 bg-zinc-100 dark:text-zinc-400 dark:bg-zinc-800';

  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${colorClass}`}>
      {/* Calendar icon */}
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="opacity-70">
        <path d="M4 1v2M12 1v2M1 6h14M3 3h10a2 2 0 012 2v8a2 2 0 01-2 2H3a2 2 0 01-2-2V5a2 2 0 012-2z" />
      </svg>
      {label}
      {/* Repeat icon if recurring */}
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-50">
        <path d="M1 8a7 7 0 0113.6-2.3M15 8a7 7 0 01-13.6 2.3" strokeLinecap="round" />
        <path d="M14.6 2v3.7h-3.7M1.4 14v-3.7h3.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
