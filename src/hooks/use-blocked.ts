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

    // Use indexed queries instead of full table scans
    const [blockedTasks, blockedSubs] = await Promise.all([
      db.tasks.where('status').equals('blocked').toArray(),
      db.subtasks.where('status').equals('blocked').toArray(),
    ]);

    // Blocked tasks (direct)
    for (const t of blockedTasks) {
      if (t.deletedAt || t.status === 'done' || t.archived) continue;
      result.push({ id: t.id, listId: t.listId, title: t.title, reason: 'task' });
    }

    // Group blocked subtasks by taskId
    const blockedByTask = new Map<string, number>();
    for (const s of blockedSubs) {
      if (s.deletedAt) continue;
      blockedByTask.set(s.taskId, (blockedByTask.get(s.taskId) || 0) + 1);
    }

    // Skip tasks already added as directly blocked
    const directlyBlocked = new Set(blockedTasks.map((t) => t.id));

    // Look up parent tasks for subtask-blocked entries
    const parentIds = [...blockedByTask.keys()].filter((id) => !directlyBlocked.has(id));
    if (parentIds.length > 0) {
      const parents = await db.tasks.bulkGet(parentIds);
      for (const parent of parents) {
        if (!parent || parent.deletedAt || parent.status === 'done' || parent.archived) continue;
        const count = blockedByTask.get(parent.id)!;
        result.push({ id: parent.id, listId: parent.listId, title: parent.title, reason: 'subtask', blockedSubtaskCount: count });
      }
    }

    return result;
  }, []);

  return items ?? [];
}
