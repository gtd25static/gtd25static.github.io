import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task, DiscussionEntry } from '../db/models';
import { PING_COOLDOWN_MS } from '../lib/constants';
import { updateTask } from './use-tasks';

const ABSOLUTE_TIMESTAMP_FLOOR = Date.UTC(2000, 0, 1);
const MAX_REASONABLE_CUSTOM_MS = 10 * 366 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Used when a topic has no cadence and no prior cooldown to fall back to.
const DEFAULT_CADENCE_MS = PING_COOLDOWN_MS['1week'];

export function useFollowUps(listId: string | null) {
  return useLiveQuery(
    async () => {
      if (!listId) return { active: [], archived: [] };
      const all = await db.tasks.where('listId').equals(listId).sortBy('order');
      const live = all.filter((t) => !t.deletedAt);
      const active = live.filter((t) => !t.archived);
      return {
        active,
        archived: live.filter((t) => t.archived),
      };
    },
    [listId],
    { active: [], archived: [] },
  );
}

export function isInCooldown(task: Task): boolean {
  return cooldownRemaining(task) > 0;
}

export function cooldownRemaining(task: Task): number {
  const until = cooldownUntil(task);
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

export function cooldownUntil(task: Task): number {
  if (!task.pingedAt || !task.pingCooldown) return 0;

  if (task.pingCooldown === 'custom') {
    if (isReasonableWakeTime(task.pingCooldownUntil)) return task.pingCooldownUntil;

    const legacy = task.pingCooldownCustomMs;
    if (!Number.isFinite(legacy) || legacy === undefined || legacy <= 0) return 0;
    if (legacy >= ABSOLUTE_TIMESTAMP_FLOOR) {
      return isReasonableWakeTime(legacy) ? legacy : 0;
    }
    if (legacy > MAX_REASONABLE_CUSTOM_MS) return 0;

    const relativeUntil = task.pingedAt + legacy;
    return isReasonableWakeTime(relativeUntil) ? relativeUntil : 0;
  }

  const cooldownMs = PING_COOLDOWN_MS[task.pingCooldown] ?? 0;
  return cooldownMs > 0 ? task.pingedAt + cooldownMs : 0;
}

function isReasonableWakeTime(value: number | undefined): value is number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return false;
  return value <= Date.now() + MAX_REASONABLE_CUSTOM_MS;
}

/**
 * When a topic was last dealt with: its newest discussion note or Discussed
 * snooze, or its creation if neither. Synced data, so non-numbers are skipped.
 */
export function lastDiscussedAt(task: Task): number {
  let latest = Number.isFinite(task.createdAt) ? task.createdAt : 0;
  if (Number.isFinite(task.pingedAt) && task.pingedAt! > latest) latest = task.pingedAt!;
  for (const entry of task.discussionLog ?? []) {
    if (Number.isFinite(entry?.at) && entry.at > latest) latest = entry.at;
  }
  return latest;
}

/** When a resolved topic was resolved: when `archived` last changed, else its last change. */
export function resolvedAt(task: Task): number {
  const stamped = task.fieldTimestamps?.archived;
  return Number.isFinite(stamped) ? stamped! : task.updatedAt;
}

/**
 * The open log's one line about the topic's life: "Open 47 days · a note every
 * ~8 days" (a resolved one counts up to its resolution; the rhythm needs two
 * notes). Null without a usable creation time — synced data.
 */
export function topicAgeLine(task: Task, now = Date.now()): string | null {
  if (typeof task.createdAt !== 'number' || !Number.isFinite(task.createdAt)) return null;
  const end = task.archived ? resolvedAt(task) : now;
  const days = Math.max(0, Math.floor((end - task.createdAt) / DAY_MS));
  const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  const age = task.archived
    ? (days < 1 ? 'Resolved within a day' : `Was open ${plural(days)}`)
    : (days < 1 ? 'Opened today' : `Open ${plural(days)}`);

  const times = (task.discussionLog ?? []).map((entry) => entry?.at).filter((at): at is number => Number.isFinite(at));
  if (times.length < 2) return age;
  const first = times.reduce((a, b) => Math.min(a, b));
  const last = times.reduce((a, b) => Math.max(a, b));
  const gapDays = Math.round((last - first) / (times.length - 1) / DAY_MS);
  return `${age} · ${gapDays <= 1 ? 'about a note a day' : `a note every ~${gapDays} days`}`;
}

/** The soonest moment one of `tasks` wakes from its snooze (epoch ms), or 0 if none is snoozed. */
export function nextWakeAt(tasks: Task[]): number {
  let soonest = 0;
  for (const task of tasks) {
    if (!isInCooldown(task)) continue;
    const until = cooldownUntil(task);
    if (!soonest || until < soonest) soonest = until;
  }
  return soonest;
}

export function formatCooldown(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  // Minutes in the last hour, which read "0h left"; never "0m" while still snoozed.
  if (hours < 1) return `${Math.max(1, Math.floor(ms / (1000 * 60)))}m`;
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * How often a follow-up comes back, for its card. Under a day in hours (the 20h
 * preset read "every 1d"); whole weeks as weeks (12 weeks read "every 3mo").
 */
export function cadenceLabel(ms: number): string {
  if (ms < DAY_MS) return `every ${Math.round(ms / (60 * 60 * 1000))}h`;
  const days = Math.round(ms / DAY_MS);
  if (days % 7 === 0) return `every ${days / 7}w`;
  if (days >= 30) return `every ${Math.round(days / 30)}mo`;
  return `every ${days}d`;
}

/**
 * The per-topic snooze cadence as a duration in ms. Resolution order:
 * explicit `snoozeCadence` (preset or custom days) -> the last `pingCooldown`
 * the user chose -> a 1-week default. Always returns a positive duration.
 */
export function cadenceMs(task: Task): number {
  if (task.snoozeCadence === 'custom') {
    if (Number.isFinite(task.snoozeCadenceDays) && (task.snoozeCadenceDays ?? 0) > 0) {
      return task.snoozeCadenceDays! * DAY_MS;
    }
  } else if (task.snoozeCadence && PING_COOLDOWN_MS[task.snoozeCadence]) {
    return PING_COOLDOWN_MS[task.snoozeCadence];
  }
  if (task.pingCooldown && task.pingCooldown !== 'custom' && PING_COOLDOWN_MS[task.pingCooldown]) {
    return PING_COOLDOWN_MS[task.pingCooldown];
  }
  return DEFAULT_CADENCE_MS;
}

/**
 * Build the snooze payload for the "Discussed" action. By default it re-snoozes
 * for the topic's cadence; pass `untilMs` to snooze until a specific absolute
 * time (the "custom date" path). Never touches the discussion log (notes are
 * logged inline on the card). Reversible via Unsnooze, which clears the ping fields.
 */
export function applyDiscussed(task: Task, opts?: { untilMs?: number }): Partial<Task> {
  const now = Date.now();
  return {
    pingedAt: now,
    pingCooldown: 'custom',
    pingCooldownCustomMs: undefined,
    pingCooldownUntil: opts?.untilMs ?? now + cadenceMs(task),
  };
}

// Per follow-up, the end of its queue of log changes.
const logQueues = new Map<string, Promise<void>>();

/**
 * Change a follow-up's discussion log, starting from the log as stored now, one
 * change at a time per follow-up. Each change used to start from the log as last
 * rendered: two notes logged in quick succession, the second write dropped the
 * first. Stored oldest-first.
 */
export function editDiscussionLog(taskId: string, edit: (log: DiscussionEntry[]) => DiscussionEntry[]): Promise<void> {
  const run = (logQueues.get(taskId) ?? Promise.resolve()).then(async () => {
    const task = await db.tasks.get(taskId);
    if (!task) return;
    const log = Array.isArray(task.discussionLog) ? task.discussionLog : [];
    await updateTask(taskId, { discussionLog: [...edit(log)].sort((a, b) => a.at - b.at) });
  });
  const settled = run.catch(() => {});
  logQueues.set(taskId, settled);
  void settled.then(() => {
    if (logQueues.get(taskId) === settled) logQueues.delete(taskId);
  });
  return run;
}
