import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { isAwake } from './use-follow-ups';

export interface ReadyFollowUpItem {
  taskId: string;
  listId: string;
  title: string;
  listName: string;
}

/**
 * Follow-ups that are "ready to discuss": live, not resolved, and not snoozed,
 * across all follow-up lists. The awake/snoozed decision is made purely from
 * plaintext metadata (ping timing), so the count is computable even when the
 * vault is locked (titles still require an unlocked vault to read).
 */
export function useReadyFollowUps(): ReadyFollowUpItem[] {
  const items = useLiveQuery(async () => {
    const lists = await db.taskLists.toArray();
    const followUpLists = lists.filter((l) => l.type === 'follow-ups' && !l.deletedAt);
    if (followUpLists.length === 0) return [];
    const nameById = new Map(followUpLists.map((l) => [l.id, l.name]));

    const result: ReadyFollowUpItem[] = [];
    for (const list of followUpLists) {
      const tasks = await db.tasks.where('listId').equals(list.id).toArray();
      for (const task of tasks) {
        if (isAwake(task)) {
          result.push({ taskId: task.id, listId: list.id, title: task.title, listName: nameById.get(list.id) ?? '' });
        }
      }
    }
    return result;
  }, []);

  return items ?? [];
}
