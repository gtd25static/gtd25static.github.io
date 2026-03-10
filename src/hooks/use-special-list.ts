import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';

export interface SpecialItem {
  id: string;
  taskId?: string;
  listId: string;
  title: string;
  parentTitle?: string;
  type: 'warning' | 'blocked' | 'recurring';
  stateDate: number;
  entityType: 'task' | 'subtask';
}

export function useSpecialList() {
  const data = useLiveQuery(async () => {
    const items: SpecialItem[] = [];
    const tasks = await db.tasks.toArray();
    const subtasks = await db.subtasks.toArray();
    const now = Date.now();

    for (const t of tasks) {
      if (t.deletedAt || t.status === 'done' || t.archived) continue;

      if (t.hasWarning) {
        items.push({
          id: t.id,
          listId: t.listId,
          title: t.title,
          type: 'warning',
          stateDate: t.warningAt ?? t.updatedAt,
          entityType: 'task',
        });
      }

      if (t.status === 'blocked') {
        items.push({
          id: t.id,
          listId: t.listId,
          title: t.title,
          type: 'blocked',
          stateDate: t.blockedAt ?? t.updatedAt,
          entityType: 'task',
        });
      }

      if (t.recurrenceType && t.nextOccurrence && t.nextOccurrence <= now && t.status !== 'blocked') {
        items.push({
          id: t.id,
          listId: t.listId,
          title: t.title,
          type: 'recurring',
          stateDate: t.nextOccurrence,
          entityType: 'task',
        });
      }
    }

    for (const s of subtasks) {
      if (s.deletedAt || s.status === 'done') continue;
      const parent = tasks.find((t) => t.id === s.taskId);
      if (!parent || parent.deletedAt || parent.archived) continue;

      if (s.hasWarning) {
        items.push({
          id: s.id,
          taskId: s.taskId,
          listId: parent.listId,
          title: s.title,
          parentTitle: parent.title,
          type: 'warning',
          stateDate: s.warningAt ?? s.updatedAt,
          entityType: 'subtask',
        });
      }

      if (s.status === 'blocked') {
        items.push({
          id: s.id,
          taskId: s.taskId,
          listId: parent.listId,
          title: s.title,
          parentTitle: parent.title,
          type: 'blocked',
          stateDate: s.blockedAt ?? s.updatedAt,
          entityType: 'subtask',
        });
      }
    }

    // Sort: warnings by warningAt asc, blocked by blockedAt asc, recurring by nextOccurrence asc
    const typeOrder = { warning: 0, blocked: 1, recurring: 2 };
    items.sort((a, b) => {
      if (a.type !== b.type) return typeOrder[a.type] - typeOrder[b.type];
      return a.stateDate - b.stateDate;
    });

    const warningCount = items.filter((i) => i.type === 'warning').length;
    const blockedCount = items.filter((i) => i.type === 'blocked').length;
    const recurringCount = items.filter((i) => i.type === 'recurring').length;

    return { items, warningCount, blockedCount, recurringCount };
  }, []);

  return data ?? { items: [], warningCount: 0, blockedCount: 0, recurringCount: 0 };
}
