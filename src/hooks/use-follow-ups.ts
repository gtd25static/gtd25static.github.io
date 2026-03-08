import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task } from '../db/models';
import { PING_COOLDOWN_MS } from '../lib/constants';

export function useFollowUps(listId: string | null) {
  return useLiveQuery(
    async () => {
      if (!listId) return { active: [], archived: [] };
      const all = await db.tasks.where('listId').equals(listId).sortBy('order');
      const live = all.filter((t) => !t.deletedAt);
      const active = live.filter((t) => !t.archived);
      active.sort((a, b) => {
        const aCool = isInCooldown(a) ? 1 : 0;
        const bCool = isInCooldown(b) ? 1 : 0;
        return aCool - bCool;
      });
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
  if (!task.pingedAt || !task.pingCooldown) return false;
  const cooldownMs =
    task.pingCooldown === 'custom'
      ? (task.pingCooldownCustomMs ?? 0)
      : PING_COOLDOWN_MS[task.pingCooldown] ?? 0;
  return Date.now() < task.pingedAt + cooldownMs;
}

export function cooldownRemaining(task: Task): number {
  if (!task.pingedAt || !task.pingCooldown) return 0;
  const cooldownMs =
    task.pingCooldown === 'custom'
      ? (task.pingCooldownCustomMs ?? 0)
      : PING_COOLDOWN_MS[task.pingCooldown] ?? 0;
  return Math.max(0, task.pingedAt + cooldownMs - Date.now());
}

export function formatCooldown(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
