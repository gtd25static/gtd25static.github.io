import { useState, useRef, useEffect } from 'react';
import type { Task, PingCooldown } from '../../db/models';
import { updateTask, deleteTask, restoreTask } from '../../hooks/use-tasks';
import { toast } from '../ui/Toast';
import { useAppState } from '../../stores/app-state';
import { useShallow } from 'zustand/react/shallow';
import { isInCooldown, cooldownRemaining, formatCooldown } from '../../hooks/use-follow-ups';
import { toggleWarning } from '../../hooks/use-warning';
import { PingCooldownBadge } from './PingCooldownBadge';
import { DropdownMenu } from '../ui/DropdownMenu';
import { formatDate, dueDateColor } from '../../lib/date-utils';
import { LinksList } from '../shared/LinksList';
import { TaskForm } from '../tasks/TaskForm';

const SNOOZE_OPTIONS: { value: PingCooldown; label: string }[] = [
  { value: '12h', label: '12 hours' },
  { value: '1week', label: '1 week' },
  { value: '1month', label: '1 month' },
  { value: 'custom', label: 'Pick a date...' },
];

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
  const [showSnoozePicker, setShowSnoozePicker] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // React to keyboard-triggered editing
  useEffect(() => {
    if (editingItemId === task.id && !editingTitle) {
      setEditedTitle(task.title);
      setEditingTitle(true);
    }
  }, [editingItemId, task.id, task.title]);

  // Close picker on outside click
  useEffect(() => {
    if (!showSnoozePicker) return;
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowSnoozePicker(false);
        setShowDatePicker(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSnoozePicker]);

  async function handleArchive() {
    await updateTask(task.id, { archived: !task.archived });
  }

  async function handleSnooze(cd: PingCooldown) {
    await updateTask(task.id, {
      pingedAt: Date.now(),
      pingCooldown: cd,
    });
    setShowSnoozePicker(false);
    setShowDatePicker(false);
  }

  async function handleSnoozeUntilDate(dateStr: string) {
    const target = new Date(dateStr);
    // Set to end of day in local timezone
    target.setHours(23, 59, 59, 999);
    const ms = target.getTime() - Date.now();
    if (ms <= 0) return;
    await updateTask(task.id, {
      pingedAt: Date.now(),
      pingCooldown: 'custom',
      pingCooldownCustomMs: ms,
    });
    setShowSnoozePicker(false);
    setShowDatePicker(false);
  }

  async function handleWake() {
    await updateTask(task.id, { pingedAt: undefined });
  }

  // Minimum date for the date picker: tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minDate = tomorrow.toISOString().split('T')[0];

  return (
    <div data-focus-id={task.id} className={`group mb-2 flex items-start gap-3 rounded-lg border px-3 py-3 shadow-sm transition-shadow hover:shadow-md ${
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

      {/* Archive button (clock icon) */}
      <button
        onClick={handleArchive}
        className="mt-0.5 shrink-0"
        title={task.archived ? 'Restore' : 'Archive'}
      >
        {task.archived ? (
          <svg width="20" height="20" viewBox="0 0 20 20" className="text-green-500 hover:text-green-600 dark:text-green-400 dark:hover:text-green-500">
            <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M6.5 10l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 20 20" className="text-orange-400 hover:text-orange-500">
            <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 6v4l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        )}
      </button>

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
            className="text-sm text-zinc-800 dark:text-zinc-200 line-clamp-3"
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
          {task.dueDate && (
            <span className={`text-xs font-medium ${dueDateColor(task.dueDate)}`}>
              {formatDate(task.dueDate)}
            </span>
          )}
          <LinksList primaryLink={task.link} primaryTitle={task.linkTitle} links={task.links} />
        </div>
      </div>

      {/* Snooze / Wake button */}
      {!task.archived && (
        <div className="relative shrink-0" ref={pickerRef}>
          {inCooldown ? (
            <button
              onClick={handleWake}
              className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
              title="Wake — remove snooze"
            >
              {formatCooldown(cooldownRemaining(task))} left
            </button>
          ) : (
            <button
              onClick={() => setShowSnoozePicker(!showSnoozePicker)}
              className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-800/40"
              title="Snooze this follow-up"
            >
              Snooze
            </button>
          )}
          {showSnoozePicker && (
            <div className="absolute right-0 z-50 mt-1 min-w-[160px] rounded-xl border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
              {SNOOZE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    if (opt.value === 'custom') {
                      setShowDatePicker(true);
                    } else {
                      handleSnooze(opt.value);
                    }
                  }}
                  className="block w-full px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {opt.label}
                </button>
              ))}
              {showDatePicker && (
                <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
                  <input
                    type="date"
                    min={minDate}
                    onChange={(e) => {
                      if (e.target.value) handleSnoozeUntilDate(e.target.value);
                    }}
                    className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                    autoFocus
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Hover actions: star + edit/delete */}
      <div className="flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 shrink-0">
        <button
          onClick={() => updateTask(task.id, { starred: !task.starred })}
          className={`rounded p-0.5 ${task.starred ? 'text-amber-500' : 'text-zinc-300 hover:text-amber-400 dark:text-zinc-600 dark:hover:text-amber-400'}`}
          title={task.starred ? 'Unstar' : 'Star'}
        >
          {task.starred ? (
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.39 6.34H19l-5.19 3.78 1.98 6.34L10 13.68l-5.79 3.78 1.98-6.34L1 7.34h6.61z" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 1l2.39 6.34H19l-5.19 3.78 1.98 6.34L10 13.68l-5.79 3.78 1.98-6.34L1 7.34h6.61z" /></svg>
          )}
        </button>
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
            { label: 'Edit', onClick: () => setEditing(true) },
            { label: 'Delete', onClick: () => {
              if (!confirm('Delete this follow-up?')) return;
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
    </div>
  );
}
