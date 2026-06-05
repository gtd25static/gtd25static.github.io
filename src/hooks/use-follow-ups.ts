import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task, DiscussionEntry } from '../db/models';
import { PING_COOLDOWN_MS } from '../lib/constants';
import { newId } from '../lib/id';

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

export function formatCooldown(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** A follow-up is "awake" when it's live, not resolved, and not snoozed. */
export function isAwake(task: Task): boolean {
  return !task.archived && !task.deletedAt && !isInCooldown(task);
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
 * Build the update payload for the "Discussed" action: append a discussion-log
 * entry and re-snooze for the topic's cadence. Reversible via the existing wake
 * (which clears the ping fields but leaves the log intact).
 */
export function applyDiscussed(task: Task, note?: string): Partial<Task> {
  const now = Date.now();
  const trimmed = note?.trim();
  const entry: DiscussionEntry = { id: newId(), at: now, ...(trimmed ? { note: trimmed } : {}) };
  const log: DiscussionEntry[] = [...(task.discussionLog ?? []), entry];
  return {
    discussionLog: log,
    pingedAt: now,
    pingCooldown: 'custom',
    pingCooldownCustomMs: undefined,
    pingCooldownUntil: now + cadenceMs(task),
  };
}
