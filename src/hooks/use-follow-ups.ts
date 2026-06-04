import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task } from '../db/models';
import { PING_COOLDOWN_MS } from '../lib/constants';

const ABSOLUTE_TIMESTAMP_FLOOR = Date.UTC(2000, 0, 1);
const MAX_REASONABLE_CUSTOM_MS = 10 * 366 * 24 * 60 * 60 * 1000;

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
