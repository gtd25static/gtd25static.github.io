import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Task, TaskList, ListType } from '../db/models';

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
    if (list.name.toLowerCase().includes(q)) {
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
    if (task.title.toLowerCase().includes(q) || task.description?.toLowerCase().includes(q)) {
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
      });
    }
  }

  for (const sub of liveSubtasks) {
    if (results.length >= MAX_SEARCH_RESULTS) return results;
    if (sub.title.toLowerCase().includes(q)) {
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
