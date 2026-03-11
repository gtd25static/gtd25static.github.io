import { createContext, useContext, type ReactNode } from 'react';
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

export interface SpecialListData {
  items: SpecialItem[];
  warningCount: number;
  blockedCount: number;
  recurringCount: number;
}

const defaultData: SpecialListData = { items: [], warningCount: 0, blockedCount: 0, recurringCount: 0 };

const SpecialListContext = createContext<SpecialListData>(defaultData);

export function SpecialListProvider({ children }: { children: ReactNode }) {
  const data = useSpecialList();
  return <SpecialListContext.Provider value={data}>{children}</SpecialListContext.Provider>;
}

export function useSpecialListContext(): SpecialListData {
  return useContext(SpecialListContext);
}

function useSpecialList() {
  const data = useLiveQuery(async () => {
    const now = Date.now();
    const items: SpecialItem[] = [];

    // Use indexed queries instead of full table scans
    const [warningTasks, blockedTasks, recurringTasks, warningSubs, blockedSubs] = await Promise.all([
      db.tasks.where('hasWarning').equals(1).toArray(),
      db.tasks.where('status').equals('blocked').toArray(),
      db.tasks.where('nextOccurrence').belowOrEqual(now).toArray(),
      db.subtasks.where('hasWarning').equals(1).toArray(),
      db.subtasks.where('status').equals('blocked').toArray(),
    ]);

    for (const t of warningTasks) {
      if (t.deletedAt || t.status === 'done' || t.archived) continue;
      items.push({
        id: t.id,
        listId: t.listId,
        title: t.title,
        type: 'warning',
        stateDate: t.warningAt ?? t.updatedAt,
        entityType: 'task',
      });
    }

    for (const t of blockedTasks) {
      if (t.deletedAt || t.status === 'done' || t.archived) continue;
      items.push({
        id: t.id,
        listId: t.listId,
        title: t.title,
        type: 'blocked',
        stateDate: t.blockedAt ?? t.updatedAt,
        entityType: 'task',
      });
    }

    for (const t of recurringTasks) {
      if (t.deletedAt || t.status === 'done' || t.archived || t.status === 'blocked') continue;
      if (!t.recurrenceType || !t.nextOccurrence) continue;
      items.push({
        id: t.id,
        listId: t.listId,
        title: t.title,
        type: 'recurring',
        stateDate: t.nextOccurrence,
        entityType: 'task',
      });
    }

    // Collect unique parent task IDs for subtask lookups
    const parentIds = new Set<string>();
    for (const s of warningSubs) {
      if (!s.deletedAt && s.status !== 'done') parentIds.add(s.taskId);
    }
    for (const s of blockedSubs) {
      if (!s.deletedAt && s.status !== 'done') parentIds.add(s.taskId);
    }

    const parents = parentIds.size > 0
      ? await db.tasks.bulkGet([...parentIds])
      : [];
    const parentMap = new Map(parents.filter(Boolean).map((p) => [p!.id, p!]));

    for (const s of warningSubs) {
      if (s.deletedAt || s.status === 'done') continue;
      const parent = parentMap.get(s.taskId);
      if (!parent || parent.deletedAt || parent.archived) continue;
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

    for (const s of blockedSubs) {
      if (s.deletedAt || s.status === 'done') continue;
      const parent = parentMap.get(s.taskId);
      if (!parent || parent.deletedAt || parent.archived) continue;
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
