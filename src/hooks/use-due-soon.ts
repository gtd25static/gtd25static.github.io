import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { DUE_SOON_DAYS } from '../lib/constants';
import { collectDueItems, taskListIds } from '../lib/attention';

export interface DueSoonItem {
  type: 'task' | 'subtask';
  id: string;
  taskId: string;
  listId: string;
  title: string;
  dueDate: number;
  parentTitle?: string;
}

export async function getDueSoonItems(now = Date.now()): Promise<DueSoonItem[]> {
  const cutoff = now + DUE_SOON_DAYS * 24 * 60 * 60 * 1000;

  const [lists, dueTasks, allSubtasks] = await Promise.all([
    db.taskLists.toArray(),
    db.tasks.where('dueDate').belowOrEqual(cutoff).toArray(),
    db.subtasks.toArray(),
  ]);

  const dueSubtasks = allSubtasks.filter((subtask) => subtask.dueDate != null && subtask.dueDate <= cutoff);
  const parentIds = new Set(dueSubtasks.map((subtask) => subtask.taskId));
  const parents = parentIds.size > 0 ? await db.tasks.bulkGet([...parentIds]) : [];
  const taskMap = new Map(dueTasks.map((task) => [task.id, task]));
  for (const parent of parents) {
    if (parent) taskMap.set(parent.id, parent);
  }

  return collectDueItems(now, [...taskMap.values()], dueSubtasks, {
    cutoff,
    allowedListIds: taskListIds(lists),
  }).map((item) => ({
    type: item.type,
    id: item.id,
    taskId: item.taskId,
    listId: item.listId,
    title: item.title,
    dueDate: item.dueDate,
    parentTitle: item.parentTitle,
  }));
}

export function useDueSoon(refreshKey = 0): DueSoonItem[] {
  const items = useLiveQuery(async () => {
    return getDueSoonItems();
  }, [refreshKey]);

  return items ?? [];
}
