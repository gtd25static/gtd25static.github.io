import { useState } from 'react';
import type { Task, PingCooldown } from '../../db/models';
import { updateTask } from '../../hooks/use-tasks';
import { applyDiscussed } from '../../hooks/use-follow-ups';

const CADENCE_PRESETS: { value: PingCooldown; label: string }[] = [
  { value: '12h', label: '12h' },
  { value: '1week', label: '1 week' },
  { value: '1month', label: '1 month' },
  { value: '3months', label: '3 months' },
];

function initialCadence(task: Task): PingCooldown {
  if (task.snoozeCadence) return task.snoozeCadence;
  if (task.pingCooldown && task.pingCooldown !== 'custom') return task.pingCooldown;
  return '1week';
}

interface Props {
  task: Task;
  align: 'right' | 'left';
  onDone: () => void;
}

/**
 * Log a discussion of this follow-up and re-snooze it for the chosen cadence.
 * Records an optional note and remembers the cadence as the topic's default, so
 * next time the user can re-snooze in one tap.
 */
export function DiscussedPopover({ task, align, onDone }: Props) {
  const [note, setNote] = useState('');
  const [cadence, setCadence] = useState<PingCooldown>(initialCadence(task));
  const [customDays, setCustomDays] = useState<string>(
    task.snoozeCadence === 'custom' && task.snoozeCadenceDays ? String(task.snoozeCadenceDays) : '',
  );

  const customDaysNum = Number(customDays);
  const customValid = cadence !== 'custom' || (Number.isFinite(customDaysNum) && customDaysNum > 0);

  async function handleSubmit() {
    if (!customValid) return;
    const cadenceUpdate: Partial<Task> = {
      snoozeCadence: cadence,
      snoozeCadenceDays: cadence === 'custom' ? customDaysNum : undefined,
    };
    // applyDiscussed reads the cadence off the task, so fold the chosen cadence in first.
    const payload = { ...cadenceUpdate, ...applyDiscussed({ ...task, ...cadenceUpdate }, note) };
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
            cadence === 'custom'
              ? 'bg-indigo-600 text-white'
              : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
          }`}
        >
          custom
        </button>
      </div>
      {cadence === 'custom' && (
        <div className="mb-2 flex items-center gap-2">
          <input
            type="number"
            min={1}
            value={customDays}
            onChange={(e) => setCustomDays(e.target.value)}
            className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          />
          <span className="text-xs text-zinc-500 dark:text-zinc-400">days</span>
        </div>
      )}
      <button
        onClick={handleSubmit}
        disabled={!customValid}
        className="w-full rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
      >
        Log &amp; snooze
      </button>
    </div>
  );
}
