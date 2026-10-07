import { useState, useRef, useEffect } from 'react';
import type { Task, PingCooldown } from '../../db/models';
import { updateTask } from '../../hooks/use-tasks';
import { applyDiscussed } from '../../hooks/use-follow-ups';
import { openNativePicker } from '../../lib/native-picker';
import { toInputDate } from '../../lib/date-utils';

const DAY_MS = 24 * 60 * 60 * 1000;

const CADENCE_PRESETS: { value: PingCooldown; label: string }[] = [
  { value: '20h', label: '20h' },
  { value: '6d', label: '6 days' },
  { value: '30d', label: '30 days' },
  { value: '12w', label: '12 weeks' },
];

// Local calendar date `days` from today, as a date input wants it.
function inDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toInputDate(date.getTime());
}

function rememberedCustomDays(task: Task): number | undefined {
  const days = task.snoozeCadenceDays;
  return task.snoozeCadence === 'custom' && Number.isFinite(days) && days! > 0 ? days : undefined;
}

// Map any remembered cadence (incl. legacy presets) onto a current preset so the
// popover opens with a sensible default; fall back to 6 days. A remembered
// custom cadence reopens as custom, dated that many days out (what the card's
// "every Nd" says).
function initialCadence(task: Task): PingCooldown {
  if (rememberedCustomDays(task)) return 'custom';
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
 * Popover behind the "Discussed" chip: re-snoozes for the chosen cadence. Notes
 * are logged in the card's inline discussion log, never here. The named presets
 * are remembered as the topic's cadence (one-tap re-snooze next time); "custom"
 * snoozes until a specific calendar date instead.
 */
export function DiscussedPopover({ task, align, onDone }: Props) {
  const [cadence, setCadence] = useState<PingCooldown>(initialCadence(task));
  const [customDate, setCustomDate] = useState<string>(() => {
    const days = rememberedCustomDays(task);
    return days ? inDays(days) : '';
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const [openUp, setOpenUp] = useState(false);
  const [shiftX, setShiftX] = useState(0);

  // The panel opens downward by default. If that would spill past the bottom of
  // the viewport (e.g. a card near the screen edge), flip it to open upward over
  // the chip so it stays fully visible. 8px matches the ContextMenu gutter.
  // Horizontally it hangs off the chip (`align`); on a phone the chip can sit
  // near the left edge, which put a right-aligned panel partly off-screen, so
  // nudge it back inside the same gutter on either side.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) setOpenUp(true);
    if (rect.left < 8) setShiftX(8 - rect.left);
    else if (rect.right > window.innerWidth - 8) setShiftX(window.innerWidth - 8 - rect.right);
  }, []);

  // Minimum date for the custom picker: tomorrow, in local time (toISOString
  // gave the UTC date, which just after local midnight was still today).
  const minDate = inDays(1);

  const isCustom = cadence === 'custom';
  const customValid = !isCustom || Boolean(customDate);

  // "Snooze" button: re-snooze for the chosen cadence/date.
  async function handleSnooze() {
    if (!customValid) return;

    if (isCustom) {
      const [year, month, day] = customDate.split('-').map(Number);
      if (!year || !month || !day) return;
      const target = new Date(year, month - 1, day, 23, 59, 59, 999);
      if (target.getTime() <= Date.now()) return;
      // Calendar days from today, so the card's "every Nd" matches the date picked.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const days = Math.max(1, Math.round((new Date(year, month - 1, day).getTime() - startOfToday.getTime()) / DAY_MS));
      const cadenceUpdate: Partial<Task> = { snoozeCadence: 'custom', snoozeCadenceDays: days };
      await updateTask(task.id, {
        ...cadenceUpdate,
        ...applyDiscussed({ ...task, ...cadenceUpdate }, { untilMs: target.getTime() }),
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
      ref={rootRef}
      onKeyDown={(e) => { if (e.key === 'Escape') onDone(); }}
      style={shiftX ? { transform: `translateX(${shiftX}px)` } : undefined}
      className={`absolute z-50 w-64 rounded-xl border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 ${align === 'right' ? 'right-0' : 'left-0'} ${openUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
    >
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
      {/* Focused on open: Discussed, then Enter, re-snoozes on the remembered cadence. */}
      <button
        onClick={handleSnooze}
        disabled={!customValid}
        autoFocus
        title="Snooze for the chosen cadence"
        className="w-full rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
      >
        Snooze
      </button>
    </div>
  );
}
