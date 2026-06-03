import type { Task } from '../db/models';

/**
 * Tasks eligible to be suggested / focused: not deleted, not done, not blocked, not
 * archived, and belonging to a 'tasks'-type list. (Extracted from useSuggestion so the
 * suggestion banner and the Focus action share one definition.)
 */
export function eligibleForFocus(tasks: Task[], taskListIds: Set<string>): Task[] {
  return tasks.filter(
    (t) =>
      !t.deletedAt &&
      t.status !== 'done' &&
      t.status !== 'blocked' &&
      !t.archived &&
      taskListIds.has(t.listId),
  );
}

/** Selection weight: grows with age, ×3 for previously-worked tasks. */
export function weightFor(task: Task, now: number): number {
  const ageDays = (now - task.createdAt) / (1000 * 60 * 60 * 24);
  const base = Math.sqrt(ageDays + 1);
  return task.workedAt ? base * 3 : base;
}

/**
 * Weighted-random single pick (older / previously-worked tasks favoured). Returns null
 * for an empty list. `rng` is injectable for deterministic tests.
 */
export function pickWeighted(tasks: Task[], now: number, rng: () => number = Math.random): Task | null {
  if (tasks.length === 0) return null;
  const weights = tasks.map((t) => weightFor(t, now));
  const total = weights.reduce((a, b) => a + b, 0);
  let pick = rng() * total;
  for (let i = 0; i < tasks.length; i++) {
    pick -= weights[i];
    if (pick <= 0) return tasks[i];
  }
  return tasks[tasks.length - 1];
}
