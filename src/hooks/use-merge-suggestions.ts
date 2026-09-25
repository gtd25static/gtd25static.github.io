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
 * Whether a task may take part in merge suggestions: live, actionable entries only
 * (not deleted, completed, or a resolved follow-up), and never a row the vault
 * could not decrypt — every quarantined row reads "⚠︎ unreadable", so they look
 * like duplicates of each other, and merging would destroy a row that is still
 * recoverable by re-syncing. Nor one without a title at all: at-rest ciphertext
 * this device holds no key for (left behind by a Paranoid disable before
 * 2026-09-25) comes back raw, and comparing its missing title crashed the app.
 */
export function isMergeCandidate(task: Task, listType: ListType): boolean {
  if (task.deletedAt || (task as { _decryptError?: boolean })._decryptError) return false;
  if (typeof task.title !== 'string') return false;
  return listType === 'follow-ups' ? !task.archived : task.status !== 'done';
}

/**
 * Near-duplicate groups within a single list, among merge candidates (see
 * isMergeCandidate). Per-list by construction; never crosses lists.
 */
export function useMergeSuggestions(
  listId: string | null,
  listType: ListType,
): MergeSuggestionGroup[] {
  const tasks = useLiveQuery(
    async () => {
      if (!listId) return [];
      const all = await db.tasks.where('listId').equals(listId).sortBy('order');
      return all.filter((t) => isMergeCandidate(t, listType));
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
