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

    const tasks = await db.tasks.toArray();
    for (const t of tasks) {
      if (t.deletedAt || t.status === 'done') continue;
      if (t.dueDate && t.dueDate <= cutoff) {
        result.push({ type: 'task', id: t.id, taskId: t.id, title: t.title, dueDate: t.dueDate });
      }
    }

    const subtasks = await db.subtasks.toArray();
    for (const s of subtasks) {
      if (s.deletedAt || s.status === 'done') continue;
      if (s.dueDate && s.dueDate <= cutoff) {
        const parent = tasks.find((t) => t.id === s.taskId);
        result.push({
          type: 'subtask',
          id: s.id,
          taskId: s.taskId,
          title: s.title,
          dueDate: s.dueDate,
          parentTitle: parent?.title,
        });
      }
    }

    result.sort((a, b) => a.dueDate - b.dueDate);
    return result;
  }, []);

  return items ?? [];
}
