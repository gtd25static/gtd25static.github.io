import type { Subtask, Task, TaskList } from '../db/models';
import { collectDueItems, taskListIds } from './attention';
import { eligibleForFocus, pickWeighted } from './focus-pick';

export interface NudgeContent {
  kind: 'overdue' | 'due-today' | 'pending';
  itemType: 'task' | 'subtask';
  title: string;
  body: string;
  taskId: string;
  listId: string;
  taskTitle: string;
  subtaskId?: string;
  subtaskTitle?: string;
  dueDate?: number;
}

/** Subset of LocalSettings the nudge scheduler depends on (kept narrow for testability). */
export interface NudgeSettings {
  nudgesEnabled?: boolean;
  nudgeIntervalHours?: number;
  nudgeWindowStart?: number;
  nudgeWindowEnd?: number;
  lastNudgeAt?: number;
}

export const NUDGE_DEFAULTS = {
  intervalHours: 3,
  windowStart: 9,
  windowEnd: 18,
} as const;

// Floor so brand-new tasks keep a tiny (non-zero) chance of being picked.
const MIN_AGE_WEIGHT_MS = 60 * 60 * 1000;
const MAX_TITLE_LEN = 60;

function truncate(title: string): string {
  const t = title.trim();
  return t.length > MAX_TITLE_LEN ? `${t.slice(0, MAX_TITLE_LEN - 1)}…` : t;
}

/**
 * Pick a single task at random, weighted linearly by age (now - createdAt) so the
 * older a task is the more likely it is to be picked — but no task is guaranteed.
 * Returns null for an empty list. `rng` is injectable for deterministic tests.
 */
export function pickWeightedByAge(tasks: Task[], now: number, rng: () => number = Math.random): Task | null {
  if (tasks.length === 0) return null;

  const weights = tasks.map((t) => Math.max(now - t.createdAt, MIN_AGE_WEIGHT_MS));
  const total = weights.reduce((sum, w) => sum + w, 0);

  let r = rng() * total;
  for (let i = 0; i < tasks.length; i++) {
    r -= weights[i];
    if (r < 0) return tasks[i];
  }
  return tasks[tasks.length - 1]; // float-rounding safety net
}

/**
 * Compute the highest-priority nudge message given the current data, or null if there
 * is nothing worth nudging about. Priority ladder:
 *   1. Overdue tasks
 *   2. Tasks due today
 *   3. Pending task: a random focusable active task (older / worked weighted)
 */
export function computeNudge(
  now: number,
  tasks: Task[],
  lists: TaskList[],
  rng: () => number = Math.random,
  subtasks: Subtask[] = [],
): NudgeContent | null {
  const allowedListIds = taskListIds(lists);

  const subtasksByTask = new Map<string, Subtask[]>();
  for (const subtask of subtasks) {
    const bucket = subtasksByTask.get(subtask.taskId) ?? [];
    bucket.push(subtask);
    subtasksByTask.set(subtask.taskId, bucket);
  }
  const active = eligibleForFocus(tasks, allowedListIds).filter((task) => {
    const taskSubtasks = (subtasksByTask.get(task.id) ?? []).filter((subtask) => !subtask.deletedAt && subtask.status !== 'done');
    return taskSubtasks.length === 0 || taskSubtasks.some((subtask) => subtask.status === 'todo');
  });
  const activeTaskIds = new Set(active.map((task) => task.id));
  const dueItems = collectDueItems(now, tasks, subtasks, {
    allowedListIds,
    includeBlocked: false,
  }).filter((item) => item.type === 'subtask' || activeTaskIds.has(item.taskId));
  const overdue = dueItems.filter((item) => item.dueDate < new Date(now).setHours(0, 0, 0, 0));
  const dueToday = dueItems.filter((item) => {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    return item.dueDate >= dayStart.getTime();
  });

  function contentFor(item: (typeof dueItems)[number], kind: 'overdue' | 'due-today'): NudgeContent {
    const title = item.title;
    return {
      kind,
      itemType: item.type,
      title: kind === 'overdue' ? 'Overdue task' : 'Due today',
      body:
        kind === 'overdue'
          ? `“${truncate(title)}” is overdue.`
          : `“${truncate(title)}” is due today.`,
      taskId: item.taskId,
      listId: item.listId,
      taskTitle: item.task.title,
      subtaskId: item.subtask?.id,
      subtaskTitle: item.subtask?.title,
      dueDate: item.dueDate,
    };
  }

  // 1. Overdue
  if (overdue.length > 0) {
    return contentFor(overdue[0], 'overdue');
  }

  // 2. Due today
  if (dueToday.length > 0) {
    return contentFor(dueToday[0], 'due-today');
  }

  // 3. Pending task fallback.
  const pick = pickWeighted(active, now, rng);
  if (!pick) return null;
  return {
    kind: 'pending',
    itemType: 'task',
    title: 'A gentle nudge',
    body: `Maybe pick this back up: “${truncate(pick.title)}”?`,
    taskId: pick.id,
    listId: pick.listId,
    taskTitle: pick.title,
    dueDate: pick.dueDate,
  };
}

/**
 * Pure gate deciding whether a nudge may fire at `now`: enabled, inside the active
 * hour window, and at least the configured interval since the last nudge.
 * The window may wrap past midnight (start > end).
 */
export function shouldNudgeNow(settings: NudgeSettings, now: number): boolean {
  if (!settings.nudgesEnabled) return false;

  const start = settings.nudgeWindowStart ?? NUDGE_DEFAULTS.windowStart;
  const end = settings.nudgeWindowEnd ?? NUDGE_DEFAULTS.windowEnd;
  const hour = new Date(now).getHours();

  const inWindow =
    start === end
      ? false // empty window → never
      : start < end
        ? hour >= start && hour < end
        : hour >= start || hour < end; // wraps past midnight
  if (!inWindow) return false;

  const intervalMs = (settings.nudgeIntervalHours ?? NUDGE_DEFAULTS.intervalHours) * 60 * 60 * 1000;
  if (settings.lastNudgeAt != null && now - settings.lastNudgeAt < intervalMs) return false;

  return true;
}
