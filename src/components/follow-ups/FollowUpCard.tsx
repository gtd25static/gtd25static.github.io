import { useState, useRef, useEffect } from 'react';
import type { Task, PingCooldown } from '../../db/models';
import { updateTask, deleteTask, restoreTask } from '../../hooks/use-tasks';
import { toast } from '../ui/Toast';
import { useAppState } from '../../stores/app-state';
import { isInCooldown } from '../../hooks/use-follow-ups';
import { PingCooldownBadge } from './PingCooldownBadge';
import { DropdownMenu } from '../ui/DropdownMenu';
import { formatDate, dueDateColor } from '../../lib/date-utils';
import { extractHostname } from '../../lib/link-utils';
import { TaskForm } from '../tasks/TaskForm';

const COOLDOWN_OPTIONS: { value: PingCooldown; label: string }[] = [
  { value: '12h', label: '12 hours' },
  { value: '1week', label: '1 week' },
  { value: '1month', label: '1 month' },
  { value: '3months', label: '3 months' },
  { value: 'custom', label: 'Custom...' },
];

interface Props {
  task: Task;
  index?: number;
}

export function FollowUpCard({ task, index }: Props) {
  const { focusedItemId, focusZone, editingItemId, setEditingItemId } = useAppState();
  const focused = focusedItemId === task.id && focusZone === 'main';
  const [editing, setEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const inCooldown = isInCooldown(task);
  const [showCooldownPicker, setShowCooldownPicker] = useState(false);
  const [customDays, setCustomDays] = useState('');
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
    if (!showCooldownPicker) return;
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowCooldownPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showCooldownPicker]);

  async function handlePing() {
    if (inCooldown) {
      await updateTask(task.id, { pingedAt: undefined });
      return;
    }
    const cooldown = task.pingCooldown ?? '12h';
    await updateTask(task.id, {
      pingedAt: Date.now(),
      pingCooldown: cooldown,
    });
  }

  async function handleDone() {
    await updateTask(task.id, { archived: !task.archived });
  }

  async function setCooldown(cd: PingCooldown) {
    if (cd === 'custom') return; // handled by custom input
    await updateTask(task.id, { pingCooldown: cd });
    setShowCooldownPicker(false);
  }

  async function setCustomCooldown() {
    const days = parseInt(customDays, 10);
    if (!days || days <= 0) return;
    await updateTask(task.id, {
      pingCooldown: 'custom',
      pingCooldownCustomMs: days * 24 * 60 * 60 * 1000,
    });
    setCustomDays('');
    setShowCooldownPicker(false);
  }

  return (
    <div data-focus-id={task.id} className={`group mb-2 flex items-start gap-3 rounded-lg border px-3 py-3 shadow-sm transition-shadow hover:shadow-md ${
      focused
        ? 'border-accent-500 ring-2 ring-accent-500/40 dark:border-accent-400 dark:ring-accent-400/30'
        : 'border-zinc-200 dark:border-zinc-700/60'
    } ${inCooldown ? 'opacity-40' : ''} ${
      index !== undefined && index % 2 === 1 ? 'bg-zinc-50/70 dark:bg-zinc-800/30' : 'bg-white dark:bg-zinc-900/50'
    }`}>
      {/* Ping button as the "checkbox" */}
      <button
        onClick={handlePing}
        className="mt-0.5 shrink-0"
        title={inCooldown ? 'Unping' : 'Ping'}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" className={inCooldown ? 'text-zinc-300 hover:text-zinc-400 dark:text-zinc-600 dark:hover:text-zinc-500' : 'text-orange-400 hover:text-orange-500'}>
          <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
          {!inCooldown && (
            <path d="M10 6v4l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          )}
          {inCooldown && (
            <path d="M7 10h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          )}
        </svg>
      </button>

      <div className="flex-1 min-w-0">
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
            className="text-sm text-zinc-800 dark:text-zinc-200"
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
          {task.link && (
            <a
              href={task.link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-accent-600 hover:underline dark:text-accent-400"
            >
              {task.linkTitle || extractHostname(task.link)}
            </a>
          )}
        </div>
      </div>

      {/* Done / Restore button — always visible */}
      <button
        onClick={handleDone}
        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
          task.archived
            ? 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
            : 'bg-green-50 text-green-600 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-800/40'
        }`}
        title={task.archived ? 'Restore' : 'Mark done & archive'}
      >
        {task.archived ? 'Restore' : 'Done'}
      </button>

      {/* Cooldown selector — always visible */}
      <div className="relative shrink-0" ref={pickerRef}>
        <button
          onClick={() => setShowCooldownPicker(!showCooldownPicker)}
          className="rounded-full px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-100 dark:text-zinc-500 dark:hover:bg-zinc-800"
          title="Set cooldown period"
        >
          {task.pingCooldown === 'custom' && task.pingCooldownCustomMs
            ? `${Math.round(task.pingCooldownCustomMs / (24 * 60 * 60 * 1000))}d`
            : task.pingCooldown ?? '12h'}
        </button>
        {showCooldownPicker && (
          <div className="absolute right-0 z-50 mt-1 min-w-[140px] rounded-xl border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            {COOLDOWN_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  if (opt.value === 'custom') {
                    // Don't close — show the custom input instead
                    setCustomDays('');
                  } else {
                    setCooldown(opt.value);
                  }
                }}
                className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                  task.pingCooldown === opt.value ? 'font-medium text-accent-600' : ''
                }`}
              >
                {opt.label}
              </button>
            ))}
            {/* Custom days input */}
            <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="1"
                  placeholder="days"
                  value={customDays}
                  onChange={(e) => setCustomDays(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setCustomCooldown(); }}
                  className="w-16 rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-800"
                />
                <button
                  onClick={setCustomCooldown}
                  className="rounded px-2 py-1 text-xs font-medium text-accent-600 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-900/30"
                >
                  Set
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Hover actions: edit/delete */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 shrink-0">
        <DropdownMenu
          trigger={
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" className="text-zinc-400">
              <circle cx="10" cy="4" r="1.5" />
              <circle cx="10" cy="10" r="1.5" />
              <circle cx="10" cy="16" r="1.5" />
            </svg>
          }
          items={[
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
