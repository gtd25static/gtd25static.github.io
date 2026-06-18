import { useState } from 'react';
import type { Task, PingCooldown, DiscussionEntry } from '../../db/models';
import { updateTask } from '../../hooks/use-tasks';
import { applyDiscussed } from '../../hooks/use-follow-ups';
import { newId } from '../../lib/id';
import { openNativePicker } from '../../lib/native-picker';

const DAY_MS = 24 * 60 * 60 * 1000;

const CADENCE_PRESETS: { value: PingCooldown; label: string }[] = [
  { value: '20h', label: '20h' },
  { value: '6d', label: '6 days' },
  { value: '30d', label: '30 days' },
  { value: '12w', label: '12 weeks' },
];

// Map any remembered cadence (incl. legacy presets) onto a current preset so the
// popover opens with a sensible default; fall back to 6 days.
function initialCadence(task: Task): PingCooldown {
  const legacy: Record<string, PingCooldown> = {
    '12h': '20h',
    '1week': '6d',
    '1month': '30d',
    '3months': '12w',
  };
  const remembered = task.snoozeCadence ?? (task.pingCooldown !== 'custom' ? task.pingCooldown : undefined);
  if (!remembered) return '6d';
  if (CADENCE_PRESETS.some((p) => p.value === remembered)) return remembered;
  return legacy[remembered] ?? '6d';
}

interface Props {
  task: Task;
  align: 'right' | 'left';
  onDone: () => void;
}

/**
 * Popover behind the "Discussed" chip: two decoupled actions. "Log" (or Enter in
 * the note field) appends the note to the discussion history without snoozing;
 * "Snooze" re-snoozes for the chosen cadence without logging. The named presets
 * are remembered as the topic's cadence (one-tap re-snooze next time); "custom"
 * snoozes until a specific calendar date instead.
 */
export function DiscussedPopover({ task, align, onDone }: Props) {
  const [note, setNote] = useState('');
  const [cadence, setCadence] = useState<PingCooldown>(initialCadence(task));
  const [customDate, setCustomDate] = useState<string>('');

  // Minimum date for the custom picker: tomorrow.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minDate = tomorrow.toISOString().split('T')[0];

  const isCustom = cadence === 'custom';
  const customValid = !isCustom || Boolean(customDate);

  // "Log" button and Enter in the note field: append the note to the discussion
  // log without touching the snooze.
  async function logNoteOnly() {
    const trimmed = note.trim();
    if (!trimmed) return;
    const entry: DiscussionEntry = { id: newId(), at: Date.now(), note: trimmed };
    await updateTask(task.id, { discussionLog: [...(task.discussionLog ?? []), entry] });
    onDone();
  }

  // "Snooze" button: re-snooze for the chosen cadence/date without logging.
  async function handleSnooze() {
    if (!customValid) return;

    if (isCustom) {
      const [year, month, day] = customDate.split('-').map(Number);
      if (!year || !month || !day) return;
      const target = new Date(year, month - 1, day, 23, 59, 59, 999);
      if (target.getTime() <= Date.now()) return;
      const days = Math.max(1, Math.round((target.getTime() - Date.now()) / DAY_MS));
      const cadenceUpdate: Partial<Task> = { snoozeCadence: 'custom', snoozeCadenceDays: days };
      await updateTask(task.id, {
        ...cadenceUpdate,
        ...applyDiscussed({ ...task, ...cadenceUpdate }, undefined, { untilMs: target.getTime() }),
      });
      onDone();
      return;
    }

    const cadenceUpdate: Partial<Task> = { snoozeCadence: cadence, snoozeCadenceDays: undefined };
    // applyDiscussed reads the cadence off the task, so fold the chosen cadence in first.
    const payload = { ...cadenceUpdate, ...applyDiscussed({ ...task, ...cadenceUpdate }) };
    await updateTask(task.id, payload);
    onDone();
  }

  return (
    <div
      className={`absolute z-50 mt-1 w-64 rounded-xl border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 ${align === 'right' ? 'right-0' : 'left-0'}`}
    >
      <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
        Note (optional)
      </label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); logNoteOnly(); } }}
        placeholder="What came of it?"
        rows={2}
        autoFocus
        className="mb-2 w-full resize-none rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
      />
      <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Snooze again in</div>
      <div className="mb-2 flex flex-wrap gap-1">
        {CADENCE_PRESETS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setCadence(opt.value)}
            className={`rounded-full px-2 py-1 text-xs font-medium ${
              cadence === opt.value
                ? 'bg-indigo-600 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => setCadence('custom')}
          className={`rounded-full px-2 py-1 text-xs font-medium ${
            isCustom
              ? 'bg-indigo-600 text-white'
              : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
          }`}
        >
          custom
        </button>
      </div>
      {isCustom && (
        <div className="mb-2">
          <input
            type="date"
            min={minDate}
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            onClick={(e) => openNativePicker(e.currentTarget)}
            autoFocus
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          />
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleSnooze}
          disabled={!customValid}
          title="Snooze for the chosen cadence (does not log the note)"
          className="flex-1 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-200 disabled:opacity-40 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
        >
          Snooze
        </button>
        <button
          onClick={logNoteOnly}
          disabled={!note.trim()}
          title="Add the note to the discussion history (does not snooze)"
          className="flex-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          Log
        </button>
      </div>
    </div>
  );
}
