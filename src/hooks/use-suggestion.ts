import { useState, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { eligibleForFocus, pickWeighted } from '../lib/focus-pick';

interface Suggestion {
  taskId: string;
  taskTitle: string;
  listId: string;
  subtaskId?: string;
  subtaskTitle?: string;
}

// Seeded PRNG (mulberry32)
function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function useSuggestion() {
  const [seed, setSeed] = useState(() => Date.now());

  const suggestion = useLiveQuery(
    async () => {
      const taskLists = await db.taskLists.toArray();
      const taskListIds = new Set(
        taskLists.filter((l) => !l.deletedAt && l.type === 'tasks').map((l) => l.id),
      );

      const tasks = await db.tasks.toArray();
      const eligible = eligibleForFocus(tasks, taskListIds);

      if (eligible.length === 0) return null;

      const now = Date.now();
      const rng = mulberry32(seed);

      // Weighted random selection: age-based with 3x boost for previously-worked tasks
      const selected = pickWeighted(eligible, now, rng) ?? eligible[0];

      const result: Suggestion = {
        taskId: selected.id,
        taskTitle: selected.title,
        listId: selected.listId,
      };

      // If task has actionable subtasks, show the first one. Blocked subtasks stay
      // visible elsewhere, but should not be suggested as next work.
      const subtasks = await db.subtasks
        .where('taskId')
        .equals(selected.id)
        .sortBy('order');
      const firstTodo = subtasks.find((s) => !s.deletedAt && s.status === 'todo');
      if (firstTodo) {
        result.subtaskId = firstTodo.id;
        result.subtaskTitle = firstTodo.title;
      }

      return result;
    },
    [seed],
    null,
  );

  const rollAgain = useCallback(() => {
    setSeed((s) => s + 1);
  }, []);

  return { suggestion, rollAgain };
}
