import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task, Subtask, TaskList } from '../db/models';
import { INBOX_LIST_NAME, DUE_SOON_DAYS } from '../lib/constants';

export interface ReviewData {
  inboxTasks: Task[];
  listsWithTasks: Array<{ list: TaskList; tasks: Task[]; staleCount: number }>;
  followUpLists: Array<{ list: TaskList; tasks: Task[] }>;
  blockedItems: Array<{ task: Task; blockedSubtasks: Subtask[] }>;
  overdueItems: Array<{ type: 'task' | 'subtask'; item: Task | Subtask; parent?: Task }>;
  stats: { completedThisWeek: number; addedThisWeek: number; streak: number };
  lastReviewedAt: number | undefined;
}

const STALE_DAYS = 7;

function startOfWeek(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay() + 1); // Monday
  return d.getTime();
}

function startOfDay(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function prevWeekday(ts: number): number {
  const oneDayMs = 24 * 60 * 60 * 1000;
  let cur = ts - oneDayMs;
  while (isWeekend(new Date(cur))) {
    cur -= oneDayMs;
  }
  return cur;
}

function computeStreak(completionDates: number[]): number {
  if (completionDates.length === 0) return 0;
  const daySet = new Set<number>();
  for (const ts of completionDates) {
    daySet.add(startOfDay(new Date(ts)));
  }
  const oneDayMs = 24 * 60 * 60 * 1000;
  let today = startOfDay(new Date());
  while (isWeekend(new Date(today))) {
    today -= oneDayMs;
  }
  let current = today;
  if (!daySet.has(current)) {
    current = prevWeekday(current);
    if (!daySet.has(current)) return 0;
  }
  let streak = 0;
  while (daySet.has(current)) {
    streak++;
    current = prevWeekday(current);
  }
  return streak;
}

export function useReviewData(): ReviewData | undefined {
  return useLiveQuery(async () => {
    const now = Date.now();
    const staleThreshold = now - STALE_DAYS * 24 * 60 * 60 * 1000;
    const weekStart = startOfWeek(new Date());
    const dueSoonThreshold = now + DUE_SOON_DAYS * 24 * 60 * 60 * 1000;

    const [allLists, allTasks, allSubtasks] = await Promise.all([
      db.taskLists.orderBy('order').toArray(),
      db.tasks.toArray(),
      db.subtasks.toArray(),
    ]);

    const liveLists = allLists.filter((l) => !l.deletedAt);
    const liveTasks = allTasks.filter((t) => !t.deletedAt);
    const liveSubtasks = allSubtasks.filter((s) => !s.deletedAt);

    // 1. Inbox tasks
    const inboxList = liveLists.find((l) => l.name === INBOX_LIST_NAME && l.type === 'tasks');
    const inboxTasks = inboxList
      ? liveTasks.filter((t) => t.listId === inboxList.id && t.status !== 'done').sort((a, b) => a.order - b.order)
      : [];

    // 2. Lists with tasks (task-type only, excluding inbox)
    const taskLists = liveLists.filter((l) => l.type === 'tasks' && l.name !== INBOX_LIST_NAME);
    const listsWithTasks = taskLists.map((list) => {
      const tasks = liveTasks
        .filter((t) => t.listId === list.id && t.status !== 'done')
        .sort((a, b) => {
          // Stalest first
          const aStale = a.updatedAt < staleThreshold ? 1 : 0;
          const bStale = b.updatedAt < staleThreshold ? 1 : 0;
          if (aStale !== bStale) return bStale - aStale;
          return a.updatedAt - b.updatedAt;
        });
      const staleCount = tasks.filter((t) => t.updatedAt < staleThreshold).length;
      return { list, tasks, staleCount };
    }).filter((entry) => entry.tasks.length > 0);

    // 3. Follow-up lists
    const fuLists = liveLists.filter((l) => l.type === 'follow-ups');
    const followUpLists = fuLists.map((list) => {
      const tasks = liveTasks
        .filter((t) => t.listId === list.id && !t.archived)
        .sort((a, b) => a.order - b.order);
      return { list, tasks };
    }).filter((entry) => entry.tasks.length > 0);

    // 4. Blocked items
    const blockedTasks = liveTasks.filter((t) => t.status === 'blocked' && !t.archived);
    const tasksWithBlockedSubs = new Map<string, Subtask[]>();
    for (const sub of liveSubtasks) {
      if (sub.status === 'blocked') {
        const arr = tasksWithBlockedSubs.get(sub.taskId) ?? [];
        arr.push(sub);
        tasksWithBlockedSubs.set(sub.taskId, arr);
      }
    }
    // Combine: tasks that are directly blocked + tasks that have blocked subtasks
    const blockedTaskIds = new Set(blockedTasks.map((t) => t.id));
    const blockedItems: ReviewData['blockedItems'] = [];
    for (const task of blockedTasks) {
      blockedItems.push({ task, blockedSubtasks: tasksWithBlockedSubs.get(task.id) ?? [] });
    }
    for (const [taskId, subs] of tasksWithBlockedSubs) {
      if (!blockedTaskIds.has(taskId)) {
        const task = liveTasks.find((t) => t.id === taskId);
        if (task && !task.archived && task.status !== 'done') {
          blockedItems.push({ task, blockedSubtasks: subs });
        }
      }
    }

    // 5. Overdue & due soon
    const overdueItems: ReviewData['overdueItems'] = [];
    for (const task of liveTasks) {
      if (task.dueDate && task.status !== 'done' && !task.archived && task.dueDate < dueSoonThreshold) {
        overdueItems.push({ type: 'task', item: task });
      }
    }
    for (const sub of liveSubtasks) {
      if (sub.dueDate && sub.status !== 'done' && sub.dueDate < dueSoonThreshold) {
        const parent = liveTasks.find((t) => t.id === sub.taskId);
        if (parent && !parent.archived) {
          overdueItems.push({ type: 'subtask', item: sub, parent });
        }
      }
    }
    // Sort: overdue first, then by date
    overdueItems.sort((a, b) => (a.item.dueDate ?? 0) - (b.item.dueDate ?? 0));

    // 6. Stats
    const allCompletionDates: number[] = [];
    let completedThisWeek = 0;
    let addedThisWeek = 0;

    for (const t of liveTasks) {
      if (t.status === 'done' && !t.archived) {
        const completedAt = t.completedAt ?? t.updatedAt;
        allCompletionDates.push(completedAt);
        if (completedAt >= weekStart) completedThisWeek++;
      }
      if (t.createdAt >= weekStart) addedThisWeek++;
    }
    for (const s of liveSubtasks) {
      if (s.status === 'done') {
        const completedAt = s.completedAt ?? s.updatedAt;
        allCompletionDates.push(completedAt);
        if (completedAt >= weekStart) completedThisWeek++;
      }
    }

    const streak = computeStreak(allCompletionDates);

    // lastReviewedAt from localSettings
    const local = await db.localSettings.get('local');
    const lastReviewedAt = (local as Record<string, unknown> | undefined)?.lastReviewedAt as number | undefined;

    return {
      inboxTasks,
      listsWithTasks,
      followUpLists,
      blockedItems,
      overdueItems,
      stats: { completedThisWeek, addedThisWeek, streak },
      lastReviewedAt,
    };
  });
}

export async function setLastReviewedAt() {
  await db.localSettings.update('local', { lastReviewedAt: Date.now() } as Record<string, unknown>);
}
