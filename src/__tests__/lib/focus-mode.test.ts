import { describe, it, expect } from 'vitest';
import {
  FOCUS_SET_SIZE,
  focusMembers,
  focusOverflow,
  localDayKey,
  selectFocusRefill,
  urgencyRank,
} from '../../lib/focus-mode';
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

const allowed = new Set(['tasks-1']);

describe('localDayKey', () => {
  it('formats as zero-padded YYYY-MM-DD', () => {
    expect(localDayKey(NOW)).toBe('2026-06-03');
  });

  it('changes exactly at local midnight', () => {
    const lateNight = new Date(2026, 5, 3, 23, 59, 0, 0).getTime();
    const justAfter = new Date(2026, 5, 4, 0, 1, 0, 0).getTime();
    expect(localDayKey(lateNight)).toBe('2026-06-03');
    expect(localDayKey(justAfter)).toBe('2026-06-04');
  });
});

describe('focusMembers / focusOverflow', () => {
  it('orders by (focusedAt asc, id asc) and excludes ineligible carriers', () => {
    const tasks = [
      makeTask({ id: 'b', focusedAt: NOW - DAY }),
      makeTask({ id: 'a', focusedAt: NOW - DAY }), // same focusedAt → id tiebreak
      makeTask({ id: 'oldest', focusedAt: NOW - 3 * DAY }),
      makeTask({ id: 'plain' }),
      makeTask({ id: 'done', focusedAt: NOW - 5 * DAY, status: 'done' }),
      makeTask({ id: 'blocked', focusedAt: NOW - 5 * DAY, status: 'blocked' }),
      makeTask({ id: 'deleted', focusedAt: NOW - 5 * DAY, deletedAt: NOW }),
      makeTask({ id: 'archived', focusedAt: NOW - 5 * DAY, archived: true }),
      makeTask({ id: 'other-list', focusedAt: NOW - 5 * DAY, listId: 'follow-ups-1' }),
    ];
    expect(focusMembers(tasks, allowed).map((t) => t.id)).toEqual(['oldest', 'a', 'b']);
  });

  it('overflow is everything beyond the set size, in canonical order', () => {
    const members = [1, 2, 3, 4, 5].map((i) =>
      makeTask({ id: `m${i}`, focusedAt: NOW - (6 - i) * DAY }),
    );
    const canonical = focusMembers(members, allowed);
    expect(canonical).toHaveLength(5);
    expect(focusOverflow(canonical).map((t) => t.id)).toEqual(['m4', 'm5']);
    expect(focusOverflow(canonical.slice(0, FOCUS_SET_SIZE))).toEqual([]);
  });
});

describe('urgencyRank', () => {
  it('ranks overdue 0, due today 1, starred 2, plain null', () => {
    expect(urgencyRank(makeTask({ id: 'o', dueDate: NOW - DAY }), NOW)).toBe(0);
    expect(urgencyRank(makeTask({ id: 't', dueDate: NOW }), NOW)).toBe(1);
    expect(urgencyRank(makeTask({ id: 's', starred: true }), NOW)).toBe(2);
    expect(urgencyRank(makeTask({ id: 'p' }), NOW)).toBeNull();
  });

  it('a starred overdue task dedupes to its best rank (0)', () => {
    expect(urgencyRank(makeTask({ id: 'so', starred: true, dueDate: NOW - DAY }), NOW)).toBe(0);
  });

  it('a future due date is not urgent (but starred still is)', () => {
    expect(urgencyRank(makeTask({ id: 'f', dueDate: NOW + 3 * DAY }), NOW)).toBeNull();
    expect(urgencyRank(makeTask({ id: 'fs', dueDate: NOW + 3 * DAY, starred: true }), NOW)).toBe(2);
  });
});

describe('selectFocusRefill', () => {
  it('full refill: 2 urgent (ladder order) + 1 weighted backlog pick', () => {
    const eligible = [
      makeTask({ id: 'backlog-1', createdAt: NOW - 30 * DAY }),
      makeTask({ id: 'starred', starred: true }),
      makeTask({ id: 'due-today', dueDate: NOW }),
      makeTask({ id: 'overdue', dueDate: NOW - 2 * DAY }),
      makeTask({ id: 'backlog-2' }),
    ];
    // rng → 0 lands the backlog pick on the first (heaviest-prefix) backlog task.
    const picks = selectFocusRefill(eligible, [], NOW, () => 0);
    expect(picks.map((t) => t.id)).toEqual(['overdue', 'due-today', 'backlog-1']);
  });

  it('overdue ordering: earlier due date first, starred loses to dated urgency', () => {
    const eligible = [
      makeTask({ id: 'starred', starred: true }),
      makeTask({ id: 'overdue-late', dueDate: NOW - DAY }),
      makeTask({ id: 'overdue-early', dueDate: NOW - 5 * DAY }),
      makeTask({ id: 'backlog' }),
    ];
    const picks = selectFocusRefill(eligible, [], NOW, () => 0);
    expect(picks.map((t) => t.id)).toEqual(['overdue-early', 'overdue-late', 'backlog']);
  });

  it('starred fills an urgent slot when only one dated task exists', () => {
    const eligible = [
      makeTask({ id: 'backlog' }),
      makeTask({ id: 'starred', starred: true }),
      makeTask({ id: 'overdue', dueDate: NOW - DAY }),
    ];
    const picks = selectFocusRefill(eligible, [], NOW, () => 0);
    expect(picks.map((t) => t.id)).toEqual(['overdue', 'starred', 'backlog']);
  });

  it('no urgent → all slots from the weighted backlog', () => {
    const eligible = [
      makeTask({ id: 'b1' }),
      makeTask({ id: 'b2' }),
      makeTask({ id: 'b3' }),
      makeTask({ id: 'b4' }),
    ];
    const picks = selectFocusRefill(eligible, [], NOW, () => 0);
    expect(picks).toHaveLength(3);
    expect(new Set(picks.map((t) => t.id)).size).toBe(3); // distinct
  });

  it('a single empty slot always goes to the backlog (the backlog reserve)', () => {
    const members = [
      makeTask({ id: 'm1', focusedAt: NOW - DAY }),
      makeTask({ id: 'm2', focusedAt: NOW - DAY }),
    ];
    const eligible = [
      ...members,
      makeTask({ id: 'overdue', dueDate: NOW - DAY }),
      makeTask({ id: 'backlog' }),
    ];
    const picks = selectFocusRefill(eligible, members, NOW, () => 0);
    expect(picks.map((t) => t.id)).toEqual(['backlog']);
  });

  it('two empty slots → 1 urgent + 1 backlog', () => {
    const members = [makeTask({ id: 'm1', focusedAt: NOW - DAY })];
    const eligible = [
      ...members,
      makeTask({ id: 'overdue-1', dueDate: NOW - DAY }),
      makeTask({ id: 'overdue-2', dueDate: NOW - 2 * DAY }),
      makeTask({ id: 'backlog' }),
    ];
    const picks = selectFocusRefill(eligible, members, NOW, () => 0);
    expect(picks.map((t) => t.id)).toEqual(['overdue-2', 'backlog']);
  });

  it('backlog dry → urgent tasks fill beyond the cap', () => {
    const eligible = [
      makeTask({ id: 'o1', dueDate: NOW - 3 * DAY }),
      makeTask({ id: 'o2', dueDate: NOW - 2 * DAY }),
      makeTask({ id: 'o3', dueDate: NOW - DAY }),
    ];
    const picks = selectFocusRefill(eligible, [], NOW, () => 0);
    expect(picks.map((t) => t.id)).toEqual(['o1', 'o2', 'o3']);
  });

  it('fewer eligible than slots → returns what exists', () => {
    const eligible = [makeTask({ id: 'only' })];
    expect(selectFocusRefill(eligible, [], NOW, () => 0).map((t) => t.id)).toEqual(['only']);
    expect(selectFocusRefill([], [], NOW)).toEqual([]);
  });

  it('members are excluded from the pool and no picks when the set is full', () => {
    const members = [1, 2, 3].map((i) => makeTask({ id: `m${i}`, focusedAt: NOW - i * DAY }));
    const eligible = [...members, makeTask({ id: 'spare' })];
    expect(selectFocusRefill(eligible, members, NOW)).toEqual([]);

    const twoMembers = members.slice(0, 2);
    const picks = selectFocusRefill([...twoMembers, makeTask({ id: 'spare' })], twoMembers, NOW, () => 0);
    expect(picks.map((t) => t.id)).toEqual(['spare']);
  });
});
