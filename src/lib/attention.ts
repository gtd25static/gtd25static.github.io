import type { Subtask, Task, TaskList } from '../db/models';

export interface AttentionItem {
  type: 'task' | 'subtask';
  id: string;
  taskId: string;
  listId: string;
  title: string;
  dueDate: number;
  task: Task;
  subtask?: Subtask;
  parentTitle?: string;
}

/** Whole-day difference (target - now) in local calendar days. */
export function dayDiff(now: number, target: number): number {
  const a = new Date(now);
  a.setHours(0, 0, 0, 0);
  const b = new Date(target);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

export function endOfDayMs(now: number): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function taskListIds(lists: TaskList[]): Set<string> {
  return new Set(lists.filter((l) => !l.deletedAt && l.type === 'tasks').map((l) => l.id));
}

export function isLiveTask(task: Task, allowedListIds?: Set<string>): boolean {
  return (
    !task.deletedAt &&
    task.status !== 'done' &&
    !task.archived &&
    (!allowedListIds || allowedListIds.has(task.listId))
  );
}

export function isLiveSubtask(subtask: Subtask, parent: Task | undefined, allowedListIds?: Set<string>): parent is Task {
  return !!parent && isLiveTask(parent, allowedListIds) && !subtask.deletedAt && subtask.status !== 'done';
}

export function collectDueItems(
  now: number,
  tasks: Task[],
  subtasks: Subtask[],
  opts: { cutoff?: number; allowedListIds?: Set<string>; includeBlocked?: boolean } = {},
): AttentionItem[] {
  const cutoff = opts.cutoff ?? endOfDayMs(now);
  const includeBlocked = opts.includeBlocked ?? true;
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const result: AttentionItem[] = [];

  for (const task of tasks) {
    if (!isLiveTask(task, opts.allowedListIds)) continue;
    if (!includeBlocked && task.status === 'blocked') continue;
    if (task.dueDate == null || task.dueDate > cutoff) continue;
    result.push({
      type: 'task',
      id: task.id,
      taskId: task.id,
      listId: task.listId,
      title: task.title,
      dueDate: task.dueDate,
      task,
    });
  }

  for (const subtask of subtasks) {
    const parent = taskMap.get(subtask.taskId);
    if (!isLiveSubtask(subtask, parent, opts.allowedListIds)) continue;
    if (!includeBlocked && subtask.status === 'blocked') continue;
    if (subtask.dueDate == null || subtask.dueDate > cutoff) continue;
    result.push({
      type: 'subtask',
      id: subtask.id,
      taskId: parent.id,
      listId: parent.listId,
      title: subtask.title,
      dueDate: subtask.dueDate,
      task: parent,
      subtask,
      parentTitle: parent.title,
    });
  }

  result.sort((a, b) => a.dueDate - b.dueDate || a.title.localeCompare(b.title));
  return result;
}

/**
 * Count of active tasks/subtasks that need attention now: overdue or due today,
 * excluding done/archived/deleted parent work and undated items.
 * Used for the app-icon and browser-tab badge.
 */
export function countAttention(
  now: number,
  tasks: Task[],
  subtasks: Subtask[] = [],
  opts: { allowedListIds?: Set<string>; includeBlocked?: boolean } = {},
): number {
  return collectDueItems(now, tasks, subtasks, opts).length;
}
