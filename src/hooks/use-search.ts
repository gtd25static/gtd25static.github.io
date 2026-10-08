import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task, TaskList, ListType } from '../db/models';
import { isInCooldown } from './use-follow-ups';

const MAX_SEARCH_RESULTS = 50;

export interface SearchResult {
  type: 'list' | 'task' | 'subtask';
  id: string;
  title: string;
  status: string;
  listId: string;
  listName: string;
  listType: ListType;
  archived?: boolean;
  /** A follow-up in its snooze (hidden in its list unless "Show snoozed" is on). */
  snoozed?: boolean;
  /**
   * Where the query matched when it wasn't the title: the stretch of the
   * description or discussion note around it, and the note's date.
   */
  match?: { text: string; at?: number };
  // For subtasks
  parentTaskId?: string;
  parentTaskTitle?: string;
  parentTaskStatus?: string;
}

export interface SearchState {
  results: SearchResult[];
  isSearching: boolean;
  maxReached: boolean;
}

// Characters of context kept on each side of a match in the result's excerpt.
const EXCERPT_RADIUS = 40;

/** `text` on one line, cut to the stretch around `q` (lowercase), with … where it was cut. */
export function excerptAround(text: string, q: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(q);
  if (at === -1) return flat.length > 2 * EXCERPT_RADIUS ? `${flat.slice(0, 2 * EXCERPT_RADIUS)}…` : flat;
  const start = Math.max(0, at - EXCERPT_RADIUS);
  const end = Math.min(flat.length, at + q.length + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** The description, else the newest discussion note, that holds `q` — as an excerpt. */
function matchOutsideTitle(task: Task, q: string): SearchResult['match'] {
  if (task.description?.toLowerCase().includes(q)) return { text: excerptAround(task.description, q) };
  // The log is synced data: entries without a string note are skipped.
  const notes = Array.isArray(task.discussionLog) ? task.discussionLog : [];
  let newest: { note: string; at: number } | undefined;
  for (const entry of notes) {
    if (typeof entry?.note !== 'string' || !entry.note.toLowerCase().includes(q)) continue;
    const at = Number.isFinite(entry.at) ? entry.at : 0;
    if (!newest || at >= newest.at) newest = { note: entry.note, at };
  }
  return newest ? { text: excerptAround(newest.note, q), at: newest.at || undefined } : undefined;
}

export async function searchDb(query: string): Promise<SearchResult[]> {
  if (!query || query.length < 1) return [];

  const q = query.toLowerCase();

  const lists = await db.taskLists.toArray();
  const liveLists = lists.filter((l) => !l.deletedAt);
  const listMap = new Map<string, TaskList>();
  for (const l of liveLists) listMap.set(l.id, l);

  const allTasks = await db.tasks.toArray();
  const liveTasks = allTasks.filter((t) => !t.deletedAt && listMap.has(t.listId));
  const taskMap = new Map<string, Task>();
  for (const t of liveTasks) taskMap.set(t.id, t);

  const allSubtasks = await db.subtasks.toArray();
  const liveSubtasks = allSubtasks.filter((s) => !s.deletedAt && taskMap.has(s.taskId));

  const results: SearchResult[] = [];

  for (const list of liveLists) {
    if (results.length >= MAX_SEARCH_RESULTS) return results;
    // `?.`: a row an older Paranoid disable left encrypted has no name/title (see isMergeCandidate).
    if (list.name?.toLowerCase().includes(q)) {
      results.push({
        type: 'list',
        id: list.id,
        title: list.name,
        status: 'list',
        listId: list.id,
        listName: list.name,
        listType: list.type,
      });
    }
  }

  for (const task of liveTasks) {
    if (results.length >= MAX_SEARCH_RESULTS) return results;
    const inTitle = task.title?.toLowerCase().includes(q);
    const match = inTitle ? undefined : matchOutsideTitle(task, q);
    if (inTitle || match) {
      const list = listMap.get(task.listId)!;
      results.push({
        type: 'task',
        id: task.id,
        title: task.title,
        status: task.status,
        listId: task.listId,
        listName: list.name,
        listType: list.type,
        archived: task.archived,
        snoozed: list.type === 'follow-ups' && !task.archived && isInCooldown(task),
        match,
      });
    }
  }

  for (const sub of liveSubtasks) {
    if (results.length >= MAX_SEARCH_RESULTS) return results;
    if (sub.title?.toLowerCase().includes(q)) {
      const task = taskMap.get(sub.taskId)!;
      const list = listMap.get(task.listId)!;
      results.push({
        type: 'subtask',
        id: sub.id,
        title: sub.title,
        status: sub.status,
        listId: task.listId,
        listName: list.name,
        listType: list.type,
        archived: task.archived,
        parentTaskId: task.id,
        parentTaskTitle: task.title,
        parentTaskStatus: task.status,
      });
    }
  }

  return results;
}

export function useSearch(query: string): SearchState {
  // Debounce the query to avoid scanning on every keystroke
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    if (!query) {
      setDebouncedQuery('');
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const isSearching = query !== '' && query !== debouncedQuery;

  const results = useLiveQuery(
    () => searchDb(debouncedQuery),
    [debouncedQuery],
    [],
  );

  return { results, isSearching, maxReached: results.length >= MAX_SEARCH_RESULTS };
}
