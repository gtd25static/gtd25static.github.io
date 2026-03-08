import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';

interface BlockedItem {
  id: string;
  listId: string;
  title: string;
  reason: 'task' | 'subtask';
  blockedSubtaskCount?: number;
}

export function useBlocked(): BlockedItem[] {
  const items = useLiveQuery(async () => {
    const result: BlockedItem[] = [];
    const tasks = await db.tasks.toArray();
    const subtasks = await db.subtasks.toArray();

    for (const t of tasks) {
      if (t.deletedAt || t.status === 'done' || t.archived) continue;

      if (t.status === 'blocked') {
        result.push({ id: t.id, listId: t.listId, title: t.title, reason: 'task' });
        continue;
      }

      const taskSubtasks = subtasks.filter((s) => s.taskId === t.id && !s.deletedAt);
      const blockedCount = taskSubtasks.filter((s) => s.status === 'blocked').length;
      if (blockedCount > 0) {
        result.push({ id: t.id, listId: t.listId, title: t.title, reason: 'subtask', blockedSubtaskCount: blockedCount });
      }
    }

    return result;
  }, []);

  return items ?? [];
}
