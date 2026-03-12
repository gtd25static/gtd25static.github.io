import { useState, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';

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
      const eligible = tasks.filter(
        (t) =>
          !t.deletedAt &&
          t.status !== 'done' &&
          t.status !== 'blocked' &&
          !t.archived &&
          taskListIds.has(t.listId),
      );

      if (eligible.length === 0) return null;

      const now = Date.now();
      const rng = mulberry32(seed);

      // Weighted random selection: age-based with 3x boost for previously-worked tasks
      const weights = eligible.map((t) => {
        const ageDays = (now - t.createdAt) / (1000 * 60 * 60 * 24);
        const base = Math.sqrt(ageDays + 1);
        return t.workedAt ? base * 3 : base;
      });
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      let pick = rng() * totalWeight;
      let selected = eligible[0];
      for (let i = 0; i < eligible.length; i++) {
        pick -= weights[i];
        if (pick <= 0) {
          selected = eligible[i];
          break;
        }
      }

      const result: Suggestion = {
        taskId: selected.id,
        taskTitle: selected.title,
        listId: selected.listId,
      };

      // If task has undone subtasks, show the first one
      const subtasks = await db.subtasks
        .where('taskId')
        .equals(selected.id)
        .sortBy('order');
      const firstUndone = subtasks.find((s) => !s.deletedAt && s.status !== 'done');
      if (firstUndone) {
        result.subtaskId = firstUndone.id;
        result.subtaskTitle = firstUndone.title;
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
