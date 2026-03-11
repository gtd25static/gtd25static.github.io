import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { DUE_SOON_DAYS } from '../lib/constants';

interface DueSoonItem {
  type: 'task' | 'subtask';
  id: string;
  taskId: string;
  title: string;
  dueDate: number;
  parentTitle?: string;
}

export function useDueSoon(): DueSoonItem[] {
  const items = useLiveQuery(async () => {
    const now = Date.now();
    const cutoff = now + DUE_SOON_DAYS * 24 * 60 * 60 * 1000;
    const result: DueSoonItem[] = [];

    // Use dueDate index for tasks (indexed)
    const dueTasks = await db.tasks.where('dueDate').belowOrEqual(cutoff).toArray();
    for (const t of dueTasks) {
      if (t.deletedAt || t.status === 'done') continue;
      result.push({ type: 'task', id: t.id, taskId: t.id, title: t.title, dueDate: t.dueDate! });
    }

    // Subtasks don't have a dueDate index — keep scan but only load subtasks
    // (no need to load all tasks just for parent title lookup)
    const allSubtasks = await db.subtasks.toArray();
    const parentIds = new Set<string>();
    const dueSubs: typeof allSubtasks = [];
    for (const s of allSubtasks) {
      if (s.deletedAt || s.status === 'done') continue;
      if (s.dueDate && s.dueDate <= cutoff) {
        dueSubs.push(s);
        parentIds.add(s.taskId);
      }
    }

    if (dueSubs.length > 0) {
      const parents = await db.tasks.bulkGet([...parentIds]);
      const parentMap = new Map(parents.filter(Boolean).map((p) => [p!.id, p!]));
      for (const s of dueSubs) {
        const parent = parentMap.get(s.taskId);
        result.push({
          type: 'subtask',
          id: s.id,
          taskId: s.taskId,
          title: s.title,
          dueDate: s.dueDate!,
          parentTitle: parent?.title,
        });
      }
    }

    result.sort((a, b) => a.dueDate - b.dueDate);
    return result;
  }, []);

  return items ?? [];
}
