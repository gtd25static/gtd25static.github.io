import { describe, it, expect } from 'vitest';
import { eligibleForFocus, weightFor, pickWeighted } from '../../lib/focus-pick';
import type { Task } from '../../db/models';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 5, 3, 12, 0, 0, 0).getTime();

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    listId: 'tasks-1',
    title: `Task ${overrides.id}`,
    status: 'todo',
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const taskListIds = new Set(['tasks-1', 'tasks-2']);

describe('eligibleForFocus', () => {
  it('excludes done, blocked, archived, deleted, and other lists', () => {
    const tasks = [
      makeTask({ id: 'ok' }),
      makeTask({ id: 'done', status: 'done' }),
      makeTask({ id: 'blocked', status: 'blocked' }),
      makeTask({ id: 'archived', archived: true }),
      makeTask({ id: 'deleted', deletedAt: NOW }),
      makeTask({ id: 'other-list', listId: 'follow-ups-1' }),
    ];
    expect(eligibleForFocus(tasks, taskListIds).map((t) => t.id)).toEqual(['ok']);
  });

  it('returns empty for no eligible tasks', () => {
    expect(eligibleForFocus([], taskListIds)).toEqual([]);
  });
});

describe('weightFor', () => {
  it('grows with age', () => {
    const young = makeTask({ id: 'y', createdAt: NOW - 1 * DAY });
    const old = makeTask({ id: 'o', createdAt: NOW - 30 * DAY });
    expect(weightFor(old, NOW)).toBeGreaterThan(weightFor(young, NOW));
  });

  it('gives a 3x boost to previously-worked tasks', () => {
    const plain = makeTask({ id: 'p', createdAt: NOW - 5 * DAY });
    const worked = makeTask({ id: 'w', createdAt: NOW - 5 * DAY, workedAt: NOW - DAY });
    expect(weightFor(worked, NOW)).toBeCloseTo(weightFor(plain, NOW) * 3, 5);
  });
});

describe('pickWeighted', () => {
  it('returns null for an empty list', () => {
    expect(pickWeighted([], NOW)).toBeNull();
  });

  it('favours older / worked tasks', () => {
    const old = makeTask({ id: 'old', createdAt: NOW - 40 * DAY });   // higher weight
    const recent = makeTask({ id: 'recent', createdAt: NOW - 1 * DAY });
    const tasks = [old, recent];

    // rng→0 lands in the first (old) segment; rng→~1 lands in the last (recent) segment.
    expect(pickWeighted(tasks, NOW, () => 0)!.id).toBe('old');
    expect(pickWeighted(tasks, NOW, () => 0.999999)!.id).toBe('recent');

    let oldWins = 0;
    const N = 100;
    for (let i = 0; i < N; i++) {
      if (pickWeighted(tasks, NOW, () => (i + 0.5) / N)!.id === 'old') oldWins++;
    }
    expect(oldWins).toBeGreaterThan(60); // old's weight (~6.4) dominates recent's (~1.4)
  });
});
