import { useState } from 'react';
import { useLocalSettings, updateLocalSettings } from '../../hooks/use-settings';
import type { LocalSettings, NudgeDayOverride } from '../../db/models';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { toast } from '../ui/Toast';
import { requestNotificationPermission, showNudgeNotification } from '../../lib/notifications';
import { computeNudge, NUDGE_DEFAULTS } from '../../lib/nudges';
import { db } from '../../db';
import { showFocusNudge } from '../../stores/focus-nudge';

function clampInt(value: string, min: number, max: number, fallback: number): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Weekday rows in Mon-first display order; idx is the Date.getDay() value (0=Sun).
const DAY_ORDER: { idx: number; label: string }[] = [
  { idx: 1, label: 'Mon' }, { idx: 2, label: 'Tue' }, { idx: 3, label: 'Wed' },
  { idx: 4, label: 'Thu' }, { idx: 5, label: 'Fri' }, { idx: 6, label: 'Sat' },
  { idx: 0, label: 'Sun' },
];

type DayState = { off: boolean; endStr: string };

function seedDayState(overrides?: Record<number, NudgeDayOverride>): Record<number, DayState> {
  const out: Record<number, DayState> = {};
  for (let d = 0; d < 7; d++) {
    const o = overrides?.[d];
    out[d] = { off: !!o?.off, endStr: o?.end != null ? String(o.end) : '' };
  }
  return out;
}

function permissionState(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200"
    >
      <span
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          checked ? 'bg-accent-600' : 'bg-zinc-300 dark:bg-zinc-600'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </span>
      {label}
    </button>
  );
}

// Inner form; seeded via useState initializers from the loaded record (mounted only
// once `local` has resolved), avoiding a copy-props-to-state effect.
function NudgeForm({ local }: { local: LocalSettings }) {
  const [enabled, setEnabled] = useState(!!local.nudgesEnabled);
  const [intervalHours, setIntervalHours] = useState(String(local.nudgeIntervalHours ?? NUDGE_DEFAULTS.intervalHours));
  const [windowStart, setWindowStart] = useState(String(local.nudgeWindowStart ?? NUDGE_DEFAULTS.windowStart));
  const [windowEnd, setWindowEnd] = useState(String(local.nudgeWindowEnd ?? NUDGE_DEFAULTS.windowEnd));
  const [soundEnabled, setSoundEnabled] = useState(local.nudgeSoundEnabled !== false);
  const [dayState, setDayState] = useState<Record<number, DayState>>(() => seedDayState(local.nudgeDayOverrides));
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(permissionState());

  function updateDay(idx: number, patch: Partial<DayState>) {
    setDayState((s) => ({ ...s, [idx]: { ...s[idx], ...patch } }));
  }

  // Persist only the days that differ from the global window: off, or an earlier end.
  function buildDayOverrides(): Record<number, NudgeDayOverride> {
    const out: Record<number, NudgeDayOverride> = {};
    for (let d = 0; d < 7; d++) {
      const s = dayState[d];
      if (s.off) { out[d] = { off: true }; continue; }
      const trimmed = s.endStr.trim();
      if (trimmed === '') continue;
      const n = parseInt(trimmed, 10);
      if (!Number.isNaN(n)) out[d] = { end: Math.max(0, Math.min(23, n)) };
    }
    return out;
  }

  async function handleToggleEnabled() {
    const next = !enabled;
    if (next) {
      const granted = await requestNotificationPermission();
      setPerm(permissionState());
      if (!granted) {
        toast('Notification permission was not granted', 'error');
        return;
      }
    }
    setEnabled(next);
    await updateLocalSettings({ nudgesEnabled: next });
  }

  async function handleSave() {
    const iv = clampInt(intervalHours, 1, 24, NUDGE_DEFAULTS.intervalHours);
    const ws = clampInt(windowStart, 0, 23, NUDGE_DEFAULTS.windowStart);
    const we = clampInt(windowEnd, 0, 23, NUDGE_DEFAULTS.windowEnd);
    if (ws === we) {
      toast('Active window start and end must differ', 'error');
      return;
    }
    const dayOverrides = buildDayOverrides();
    setIntervalHours(String(iv));
    setWindowStart(String(ws));
    setWindowEnd(String(we));
    setDayState(seedDayState(dayOverrides)); // normalise displayed end hours / clear invalid
    await updateLocalSettings({
      nudgeIntervalHours: iv,
      nudgeWindowStart: ws,
      nudgeWindowEnd: we,
      nudgeDayOverrides: dayOverrides,
      nudgeSoundEnabled: soundEnabled,
    });
    toast('Notification settings saved', 'success');
  }

  async function handleTest() {
    const granted = await requestNotificationPermission();
    setPerm(permissionState());
    if (!granted) {
      toast('Allow notifications first', 'error');
      return;
    }
    const [tasks, lists, subtasks] = await Promise.all([db.tasks.toArray(), db.taskLists.toArray(), db.subtasks.toArray()]);
    const nudge = computeNudge(Date.now(), tasks, lists, Math.random, subtasks);
    if (nudge) {
      showFocusNudge(nudge);
      showNudgeNotification(nudge.title, nudge.body, { sound: soundEnabled });
      return;
    }
    const fallback = { title: 'GTD25', body: "This is how nudges look. Nothing pending right now 🎉" };
    showNudgeNotification(fallback.title, fallback.body, { sound: soundEnabled });
    toast('Test nudge sent', 'success');
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Nudge Notifications</h3>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Gentle reminders about pending work, shown while the app is open or installed.
        {perm === 'denied' && ' Notifications are blocked in your browser settings.'}
        {perm === 'unsupported' && ' Your browser does not support notifications.'}
      </p>

      <Toggle checked={enabled} onChange={handleToggleEnabled} label="Enable nudges" />

      <div className="grid grid-cols-3 gap-2">
        <Input
          label="Every (hours)"
          type="number"
          min={1}
          max={24}
          value={intervalHours}
          onChange={(e) => setIntervalHours(e.target.value)}
        />
        <Input
          label="From (hour)"
          type="number"
          min={0}
          max={23}
          value={windowStart}
          onChange={(e) => setWindowStart(e.target.value)}
        />
        <Input
          label="To (hour)"
          type="number"
          min={0}
          max={23}
          value={windowEnd}
          onChange={(e) => setWindowEnd(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-300">Quiet days / earlier cutoffs</p>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Turn a day off, or give it an end hour earlier than “To”. The start stays the global “From”.
        </p>
        <div className="space-y-1.5">
          {DAY_ORDER.map(({ idx, label }) => {
            const ds = dayState[idx];
            return (
              <div key={idx} className="flex items-center gap-3">
                <span className="w-24">
                  <Toggle checked={!ds.off} onChange={() => updateDay(idx, { off: !ds.off })} label={label} />
                </span>
                {ds.off ? (
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">silenced</span>
                ) : (
                  <label className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                    until
                    <Input
                      className="w-16"
                      type="number"
                      min={0}
                      max={23}
                      aria-label={`${label} end hour`}
                      value={ds.endStr}
                      placeholder={windowEnd || String(NUDGE_DEFAULTS.windowEnd)}
                      onChange={(e) => updateDay(idx, { endStr: e.target.value })}
                    />
                    :00
                  </label>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Toggle
        checked={soundEnabled}
        onChange={() => setSoundEnabled((s) => !s)}
        label="Play a discreet chime"
      />

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={handleSave}>Save</Button>
        <Button size="sm" variant="secondary" onClick={handleTest}>Send test nudge</Button>
      </div>
    </div>
  );
}

export function NotificationSettings() {
  const local = useLocalSettings();
  // deviceId is set during ensureDefaults, so its presence marks a real loaded record
  // (vs. the loading fallback). Mount the form only then so initializers see real data.
  if (local.deviceId === undefined) return null;
  return <NudgeForm local={local} />;
}
