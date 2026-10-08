import { useState, useRef, useEffect, useCallback } from 'react';
import type { Task, DiscussionEntry } from '../../db/models';
import { updateTask, deleteTask, restoreTask, moveTaskToList } from '../../hooks/use-tasks';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/ConfirmDialog';
import { useAppState } from '../../stores/app-state';
import { useShallow } from 'zustand/react/shallow';
import { isInCooldown, cooldownRemaining, formatCooldown, cadenceMs, cadenceLabel } from '../../hooks/use-follow-ups';
import { toggleWarning } from '../../hooks/use-warning';
import { useTaskLists } from '../../hooks/use-task-lists';
import { PingCooldownBadge } from './PingCooldownBadge';
import { DiscussedPopover } from './DiscussedPopover';
import { sendToList } from '../tasks/send-to-list';
import { DiscussionLog } from './DiscussionLog';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { DropdownMenu } from '../ui/DropdownMenu';
import { formatDate, dueDateColor, formatTimeAgo } from '../../lib/date-utils';
import { LinksList } from '../shared/LinksList';
import { ExpandableText } from '../shared/ExpandableText';
import { TaskForm } from '../tasks/TaskForm';
import { RESOLVE_FOLLOW_UP_QUESTION } from '../../lib/constants';

// Action-chip layout: a 44px tap target on phones (per platform touch guidance),
// a touch more compact on md+ desktop. Colours are appended per chip.
const chipBase =
  'inline-flex shrink-0 items-center justify-center rounded-full px-3.5 text-sm font-medium min-h-[44px] md:min-h-0 md:px-3 md:py-1.5';

interface Props {
  task: Task;
  index?: number;
  dragHandleProps?: Record<string, unknown>;
}

export function FollowUpCard({ task, index, dragHandleProps }: Props) {
  const { focusedItemId, focusZone, editingItemId, setEditingItemId, expanded, toggleTaskExpanded, ensureTaskExpanded, hasDraft, setNoteFocusTaskId } = useAppState(useShallow(s => ({ focusedItemId: s.focusedItemId, focusZone: s.focusZone, editingItemId: s.editingItemId, setEditingItemId: s.setEditingItemId, expanded: s.expandedTaskIds.has(task.id), toggleTaskExpanded: s.toggleTaskExpanded, ensureTaskExpanded: s.ensureTaskExpanded, hasDraft: Boolean(s.noteDrafts[task.id]), setNoteFocusTaskId: s.setNoteFocusTaskId })));
  const focused = focusedItemId === task.id && focusZone === 'main';
  const [editing, setEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const inCooldown = isInCooldown(task);
  const lists = useTaskLists();
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showDiscussed, setShowDiscussed] = useState(false);
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
    if (!await confirmDialog(RESOLVE_FOLLOW_UP_QUESTION, { confirmLabel: 'Resolve' })) return;
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

  // A click anywhere on the card that isn't one of its controls opens or closes
  // the discussion log. Menus are portals (their React events still bubble here,
  // but they aren't in the card's DOM); the Discussed popover and the drag handle
  // opt out; a drag that selected text isn't a tap.
  function handleCardClick(e: React.MouseEvent) {
    const target = e.target as Element;
    if (!e.currentTarget.contains(target)) return;
    if (target.closest('button, a, input, textarea, select, label, [data-no-card-toggle]')) return;
    if (window.getSelection()?.toString()) return;
    // Opened with a mouse, the note box is ready to type in; by touch it isn't
    // focused (the on-screen keyboard would cover the log).
    if (!expanded && (e.nativeEvent as PointerEvent).pointerType === 'mouse') setNoteFocusTaskId(task.id);
    toggleTaskExpanded(task.id);
  }

  // The newest log entry (the last added among equal times), for the closed card.
  const logLength = task.discussionLog?.length ?? 0;
  const latest = (task.discussionLog ?? []).reduce<DiscussionEntry | undefined>(
    (newest, entry) => (!newest || entry.at >= newest.at ? entry : newest),
    undefined,
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  function buildContextMenuItems(): MenuItem[] {
    const otherLists = lists.filter((l) => l.id !== task.listId && l.type === 'follow-ups' && !l.archivedAt);
    const items: MenuItem[] = [
      { label: task.starred ? 'Unstar' : 'Star', onClick: () => updateTask(task.id, { starred: !task.starred }) },
      { label: task.hasWarning ? 'Clear warning' : 'Warn', onClick: () => toggleWarning('task', task.id) },
      { label: 'History', onClick: () => ensureTaskExpanded(task.id) },
    ];
    if (otherLists.length > 0) {
      items.push({
        label: 'Send to list',
        children: otherLists.map((l) => ({
          label: l.name,
          onClick: () => void sendToList(task, l),
        })),
      });
    }
    const taskLists = lists.filter((l) => l.type === 'tasks' && !l.archivedAt);
    if (taskLists.length > 0) {
      items.push({
        label: 'Send to task list',
        children: taskLists.map((l) => ({
          label: l.name,
          onClick: () => {
            void moveTaskToList(task.id, l.id).then((moved) => {
              if (moved) toast(`Moved to ${l.name}`, 'success');
            });
          },
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
    // Open, the card stands out from the list around it: accent border, more
    // shadow, a little room above and below, and no zebra tint.
    <div data-focus-id={task.id} data-redact onContextMenu={handleContextMenu} className={`group rounded-lg border transition-shadow ${
      expanded ? 'my-3 shadow-md' : 'mb-2 shadow-sm hover:shadow-md'
    } ${
      focused
        ? 'border-accent-500 ring-2 ring-accent-500/40 dark:border-accent-400 dark:ring-accent-400/30'
        : expanded ? 'border-accent-300 dark:border-accent-700' : 'border-zinc-200 dark:border-zinc-700/60'
    } ${inCooldown && !expanded ? 'opacity-40' : ''} ${
      !expanded && index !== undefined && index % 2 === 1 ? 'bg-zinc-50/70 dark:bg-zinc-800/30' : 'bg-white dark:bg-zinc-900/50'
    }`}>
      {/* Summary row — click to open/close the discussion log below */}
      <div onClick={handleCardClick} className="flex cursor-pointer flex-col md:flex-row md:items-start gap-2 md:gap-3 px-3 py-3">
      {/* Title + content region — its own row on phones, dissolves into the card row on md+ */}
      <div className="flex items-start gap-3 md:contents">
      {/* Drag handle */}
      {dragHandleProps && (
        <div
          data-no-card-toggle
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
          <ExpandableText
            as="span"
            text={task.title}
            clamp={3}
            className="text-sm text-zinc-800 dark:text-zinc-200"
            title="Double-click to edit"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditedTitle(task.title);
              setEditingTitle(true);
            }}
          />
        )}
        {task.description && (
          <ExpandableText
            as="p"
            text={task.description}
            clamp={1}
            className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400"
          />
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
          {!expanded && hasDraft && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" title="A note typed in the log and not logged yet">
              Unsent note
            </span>
          )}
          <LinksList primaryLink={task.link} primaryTitle={task.linkTitle} links={task.links} />
        </div>
        {/* Closed: when it was last discussed, and the first line of what was said */}
        {!expanded && latest && (
          <p className="mt-1 flex min-w-0 items-baseline gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="shrink-0 font-medium text-accent-700 dark:text-accent-300">{formatTimeAgo(latest.at)}</span>
            {latest.note
              ? <span data-redact className="truncate">{latest.note.split('\n')[0]}</span>
              : <span className="italic">No note</span>}
          </p>
        )}
      </div>
      </div>

      {/* Action chips — a second row on phones (wraps if needed), inline on the card row on md+ */}
      <div className="flex flex-wrap items-center gap-2 md:contents">
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

      {/* Discussed button — re-snooze for a chosen cadence (notes go in the log below) */}
      {!task.archived && (
        <div data-no-card-toggle className="relative shrink-0" ref={discussedRef}>
          <button
            onClick={() => setShowDiscussed((v) => !v)}
            className={`${chipBase} bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 dark:hover:bg-emerald-800/40`}
            title="Snooze for a chosen cadence"
          >
            Discussed
          </button>
          {showDiscussed && (
            <DiscussedPopover
              task={task}
              align="right"
              // Back on the chip (Escape, Snooze, Log): the focus was left on <body>.
              onDone={() => { setShowDiscussed(false); discussedRef.current?.querySelector('button')?.focus(); }}
            />
          )}
        </div>
      )}

      {/* History — shown when there's a discussion log; opens/closes it below the card */}
      {logLength > 0 && (
        <button
          onClick={() => toggleTaskExpanded(task.id)}
          aria-expanded={expanded}
          className={`${chipBase} ${expanded
            ? 'bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-600'
            : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'}`}
          title={expanded ? 'Hide the discussion log' : 'Show the discussion log'}
        >
          History · {logLength}
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
          label="Follow-up options"
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
            { label: 'History', onClick: () => ensureTaskExpanded(task.id) },
            { label: 'Edit', onClick: () => setEditing(true) },
            { label: 'Delete', onClick: async () => {
              if (!await confirmDialog('Delete this follow-up?', { confirmLabel: 'Delete' })) return;
              deleteTask(task.id);
              toast('Follow-up deleted', 'info', () => restoreTask(task.id));
            }, danger: true },
          ]}
        />
      </div>
      </div>
      </div>

      {/* The log on its own tinted panel, so it doesn't read as more cards (7px: inside the card's 8px corner) */}
      {expanded && (
        <div className="rounded-b-[7px] border-t border-accent-100 bg-accent-50/60 px-3 pb-3 pt-2.5 dark:border-accent-900/60 dark:bg-accent-950/25">
          <DiscussionLog task={task} />
        </div>
      )}

      {editing && (
        <TaskForm
          allowRecurrence={false}
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
}
