import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task, ListType } from '../db/models';
import { findDuplicateGroups } from '../lib/similarity';

export interface MergeSuggestionGroup {
  /** Stable signature (sorted member ids) used to track per-session dismissal. */
  signature: string;
  tasks: Task[];
  score: number;
}

/**
 * Near-duplicate groups within a single list. Compares live, actionable entries
 * only — excludes deleted, completed tasks, and resolved (archived) follow-ups.
 * Per-list by construction; never crosses lists.
 */
export function useMergeSuggestions(
  listId: string | null,
  listType: ListType,
): MergeSuggestionGroup[] {
  const tasks = useLiveQuery(
    async () => {
      if (!listId) return [];
      const all = await db.tasks.where('listId').equals(listId).sortBy('order');
      return all.filter((t) => {
        if (t.deletedAt) return false;
        return listType === 'follow-ups' ? !t.archived : t.status !== 'done';
      });
    },
    [listId, listType],
    [],
  );

  return useMemo(() => {
    const groups = findDuplicateGroups(tasks.map((t) => ({ id: t.id, title: t.title })));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return groups
      .map((g) => ({
        signature: [...g.ids].sort().join('|'),
        tasks: g.ids.map((id) => byId.get(id)).filter((t): t is Task => !!t),
        score: g.score,
      }))
      .filter((g) => g.tasks.length >= 2);
  }, [tasks]);
}
