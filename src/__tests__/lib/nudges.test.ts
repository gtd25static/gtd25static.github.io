import { describe, it, expect } from 'vitest';
import { computeNudge, pickWeightedByAge, shouldNudgeNow, NUDGE_DEFAULTS } from '../../lib/nudges';
import type { Subtask, Task, TaskList } from '../../db/models';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Fixed "now" inside the default 9–18 window: 2026-06-03 12:00 local.
const NOW = new Date(2026, 5, 3, 12, 0, 0, 0).getTime();

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    listId: 'list-1',
    title: `Task ${overrides.id}`,
    status: 'todo',
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSubtask(overrides: Partial<Subtask> & { id: string; taskId: string }): Subtask {
  return {
    title: `Subtask ${overrides.id}`,
    status: 'todo',
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const inboxList: TaskList = {
  id: 'inbox', name: 'Inbox', type: 'tasks', order: 0, createdAt: NOW, updatedAt: NOW,
};
const normalList: TaskList = {
  id: 'list-1', name: 'Work', type: 'tasks', order: 1, createdAt: NOW, updatedAt: NOW,
};
const lists = [inboxList, normalList];

describe('computeNudge — priority ladder', () => {
  it('returns null when there is no pending work', () => {
    expect(computeNudge(NOW, [], lists)).toBeNull();
    const allDone = [makeTask({ id: 'a', status: 'done' })];
    expect(computeNudge(NOW, allDone, lists)).toBeNull();
  });

  it('overdue beats due-today, inbox, and fallback', () => {
    const tasks = [
      makeTask({ id: 'overdue', dueDate: NOW - 2 * DAY }),
      makeTask({ id: 'today', dueDate: NOW }),
      makeTask({ id: 'inbox-item', listId: 'inbox' }),
      makeTask({ id: 'plain' }),
    ];
    const nudge = computeNudge(NOW, tasks, lists)!;
    expect(nudge.kind).toBe('overdue');
    expect(nudge.itemType).toBe('task');
    expect(nudge.taskId).toBe('overdue');
    expect(nudge.title).toBe('Overdue task');
  });

  it('names the single overdue task', () => {
    const tasks = [makeTask({ id: 'x', title: 'Pay rent', dueDate: NOW - DAY })];
    expect(computeNudge(NOW, tasks, lists)!.body).toContain('Pay rent');
  });

  it('due-today beats inbox and fallback when nothing is overdue', () => {
    const tasks = [
      makeTask({ id: 'today', dueDate: NOW }),
      makeTask({ id: 'inbox-item', listId: 'inbox' }),
      makeTask({ id: 'plain' }),
    ];
    const nudge = computeNudge(NOW, tasks, lists)!;
    expect(nudge.kind).toBe('due-today');
    expect(nudge.itemType).toBe('task');
    expect(nudge.taskId).toBe('today');
    expect(nudge.title).toBe('Due today');
  });

  it('can nudge a due subtask under an active task', () => {
    const parent = makeTask({ id: 'parent', title: 'Project' });
    const subtask = makeSubtask({ id: 'sub', taskId: parent.id, title: 'Send update', dueDate: NOW - DAY });
    const nudge = computeNudge(NOW, [parent], lists, () => 0, [subtask])!;
    expect(nudge.kind).toBe('overdue');
    expect(nudge.itemType).toBe('subtask');
    expect(nudge.taskId).toBe(parent.id);
    expect(nudge.subtaskId).toBe(subtask.id);
    expect(nudge.subtaskTitle).toBe('Send update');
  });

  it('falls back to a concrete pending task when nothing is due', () => {
    const tasks = [
      makeTask({ id: 'inbox-item', listId: 'inbox', createdAt: NOW - 10 * DAY }),
      makeTask({ id: 'plain' }),
    ];
    const nudge = computeNudge(NOW, tasks, lists, () => 0)!;
    expect(nudge.kind).toBe('pending');
    expect(nudge.itemType).toBe('task');
    expect(nudge.taskId).toBe('inbox-item');
    expect(nudge.title).toBe('A gentle nudge');
  });

  it('ignores done/blocked/archived/deleted/non-task-list items when classifying', () => {
    const tasks = [
      makeTask({ id: 'overdue-done', dueDate: NOW - DAY, status: 'done' }),
      makeTask({ id: 'overdue-blocked', dueDate: NOW - DAY, status: 'blocked' }),
      makeTask({ id: 'overdue-archived', dueDate: NOW - DAY, archived: true }),
      makeTask({ id: 'overdue-deleted', dueDate: NOW - DAY, deletedAt: NOW }),
      makeTask({ id: 'overdue-followup', dueDate: NOW - DAY, listId: 'follow-ups' }),
      makeTask({ id: 'plain' }),
    ];
    const nudge = computeNudge(
      NOW,
      tasks,
      [...lists, { id: 'follow-ups', name: 'Follow-ups', type: 'follow-ups', order: 2, createdAt: NOW, updatedAt: NOW }],
      () => 0,
    )!;
    expect(nudge.kind).toBe('pending');
    expect(nudge.taskId).toBe('plain');
  });

  it('a future due date is neither overdue nor due-today', () => {
    const tasks = [makeTask({ id: 'future', dueDate: NOW + 3 * DAY })];
    expect(computeNudge(NOW, tasks, lists)!.title).toBe('A gentle nudge');
  });
});

describe('computeNudge — fallback gating', () => {
  it('does NOT use the random fallback while anything is overdue or due today', () => {
    const withOverdue = [
      makeTask({ id: 'o', dueDate: NOW - DAY }),
      makeTask({ id: 'p' }),
    ];
    expect(computeNudge(NOW, withOverdue, lists)!.kind).toBe('overdue');

    const withDueToday = [
      makeTask({ id: 't', dueDate: NOW }),
      makeTask({ id: 'p' }),
    ];
    expect(computeNudge(NOW, withDueToday, lists)!.kind).toBe('due-today');
  });

  it('engages the random fallback only when nothing is overdue or due today', () => {
    const tasks = [makeTask({ id: 'plain', title: 'Read book' })];
    const nudge = computeNudge(NOW, tasks, lists, () => 0)!;
    expect(nudge.kind).toBe('pending');
    expect(nudge.itemType).toBe('task');
    expect(nudge.taskId).toBe('plain');
    expect(nudge.title).toBe('A gentle nudge');
    expect(nudge.body).toContain('Read book');
  });
});

describe('pickWeightedByAge', () => {
  it('returns null for an empty list', () => {
    expect(pickWeightedByAge([], NOW)).toBeNull();
  });

  it('favours older tasks: most of the probability mass goes to the oldest', () => {
    const old = makeTask({ id: 'old', createdAt: NOW - 10 * DAY });   // weight ~10d
    const recent = makeTask({ id: 'recent', createdAt: NOW - 1 * DAY }); // weight ~1d
    const tasks = [old, recent];

    // total weight ≈ 11d; old occupies ~10/11 (≈0.909). r = rng()*total.
    expect(pickWeightedByAge(tasks, NOW, () => 0.5)!.id).toBe('old');   // r ≈ 5.5d < 10d
    expect(pickWeightedByAge(tasks, NOW, () => 0.99)!.id).toBe('recent'); // r ≈ 10.9d > 10d

    // Sample across the unit interval: the older task should win the large majority.
    let oldWins = 0;
    const N = 100;
    for (let i = 0; i < N; i++) {
      if (pickWeightedByAge(tasks, NOW, () => (i + 0.5) / N)!.id === 'old') oldWins++;
    }
    expect(oldWins).toBeGreaterThan(85);
  });

  it('gives brand-new tasks a small but non-zero chance (age floor)', () => {
    const old = makeTask({ id: 'old', createdAt: NOW - 100 * DAY });
    const brandNew = makeTask({ id: 'new', createdAt: NOW }); // floored to 1h weight
    // rng()→1 lands in the very top slice, which belongs to the new task.
    expect(pickWeightedByAge([old, brandNew], NOW, () => 0.999999)!.id).toBe('new');
  });
});

describe('shouldNudgeNow', () => {
  const base = { nudgesEnabled: true, nudgeIntervalHours: 3, nudgeWindowStart: 9, nudgeWindowEnd: 18 };

  it('is false when disabled', () => {
    expect(shouldNudgeNow({ ...base, nudgesEnabled: false }, NOW)).toBe(false);
  });

  it('is true inside the window with no prior nudge', () => {
    expect(shouldNudgeNow(base, NOW)).toBe(true); // NOW is 12:00
  });

  it('is false outside the active window', () => {
    const at7am = new Date(2026, 5, 3, 7, 0, 0).getTime();
    const at8pm = new Date(2026, 5, 3, 20, 0, 0).getTime();
    expect(shouldNudgeNow(base, at7am)).toBe(false);
    expect(shouldNudgeNow(base, at8pm)).toBe(false);
  });

  it('respects window edges: start inclusive, end exclusive', () => {
    const at9 = new Date(2026, 5, 3, 9, 0, 0).getTime();
    const at18 = new Date(2026, 5, 3, 18, 0, 0).getTime();
    expect(shouldNudgeNow(base, at9)).toBe(true);
    expect(shouldNudgeNow(base, at18)).toBe(false);
  });

  it('is false within the interval since the last nudge, true after', () => {
    expect(shouldNudgeNow({ ...base, lastNudgeAt: NOW - 1 * HOUR }, NOW)).toBe(false);
    expect(shouldNudgeNow({ ...base, lastNudgeAt: NOW - 4 * HOUR }, NOW)).toBe(true);
  });

  it('handles a window that wraps past midnight', () => {
    const overnight = { ...base, nudgeWindowStart: 22, nudgeWindowEnd: 6 };
    const at23 = new Date(2026, 5, 3, 23, 0, 0).getTime();
    const at3 = new Date(2026, 5, 3, 3, 0, 0).getTime();
    const at12 = new Date(2026, 5, 3, 12, 0, 0).getTime();
    expect(shouldNudgeNow(overnight, at23)).toBe(true);
    expect(shouldNudgeNow(overnight, at3)).toBe(true);
    expect(shouldNudgeNow(overnight, at12)).toBe(false);
  });

  it('an empty window (start === end) never fires', () => {
    expect(shouldNudgeNow({ ...base, nudgeWindowStart: 12, nudgeWindowEnd: 12 }, NOW)).toBe(false);
  });

  it('falls back to defaults when window/interval are unset', () => {
    expect(NUDGE_DEFAULTS.windowStart).toBe(9);
    expect(shouldNudgeNow({ nudgesEnabled: true }, NOW)).toBe(true);
  });
});
