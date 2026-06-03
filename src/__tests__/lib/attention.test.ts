import { describe, it, expect } from 'vitest';
import { dayDiff, countAttention } from '../../lib/attention';
import type { Task } from '../../db/models';

const DAY = 24 * 60 * 60 * 1000;
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

describe('dayDiff', () => {
  it('classifies yesterday/today/tomorrow relative to now', () => {
    expect(dayDiff(NOW, NOW - DAY)).toBe(-1);
    expect(dayDiff(NOW, NOW)).toBe(0);
    expect(dayDiff(NOW, NOW + DAY)).toBe(1);
  });

  it('treats any time on the same calendar day as 0', () => {
    const endOfDay = new Date(2026, 5, 3, 23, 30, 0).getTime();
    expect(dayDiff(NOW, endOfDay)).toBe(0);
  });
});

describe('countAttention', () => {
  it('counts overdue and due-today active tasks', () => {
    const tasks = [
      makeTask({ id: 'overdue', dueDate: NOW - 2 * DAY }),
      makeTask({ id: 'today', dueDate: NOW + 6 * 60 * 60 * 1000 }), // later today
      makeTask({ id: 'future', dueDate: NOW + 3 * DAY }),
      makeTask({ id: 'nodue' }),
    ];
    expect(countAttention(NOW, tasks)).toBe(2);
  });

  it('excludes done, archived, and deleted tasks', () => {
    const tasks = [
      makeTask({ id: 'done', dueDate: NOW - DAY, status: 'done' }),
      makeTask({ id: 'archived', dueDate: NOW - DAY, archived: true }),
      makeTask({ id: 'deleted', dueDate: NOW - DAY, deletedAt: NOW }),
    ];
    expect(countAttention(NOW, tasks)).toBe(0);
  });

  it('is 0 when nothing is due', () => {
    expect(countAttention(NOW, [makeTask({ id: 'a' }), makeTask({ id: 'b', dueDate: NOW + 10 * DAY })])).toBe(0);
  });
});
