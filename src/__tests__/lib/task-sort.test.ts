import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sortTasksForDisplay, sortFollowUpsForDisplay } from '../../lib/task-sort';
import type { Task } from '../../db/models';

function makeTask(overrides: Partial<Task> & { id: string; order: number }): Task {
  return {
    listId: 'list-1',
    title: `Task ${overrides.id}`,
    status: 'todo',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('sortTasksForDisplay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-18T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  it('puts starred tasks first', () => {
    const tasks = [
      makeTask({ id: 'a', order: 0 }),
      makeTask({ id: 'b', order: 1, starred: true }),
      makeTask({ id: 'c', order: 2 }),
    ];
    const sorted = sortTasksForDisplay(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('puts due-within-7-days tasks second, sorted by dueDate asc', () => {
    const now = Date.now();
    const tasks = [
      makeTask({ id: 'a', order: 0 }),
      makeTask({ id: 'b', order: 1, dueDate: now + 5 * MS_PER_DAY }),
      makeTask({ id: 'c', order: 2, dueDate: now + 2 * MS_PER_DAY }),
    ];
    const sorted = sortTasksForDisplay(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['c', 'b', 'a']);
  });

  it('puts starred before due-soon', () => {
    const now = Date.now();
    const tasks = [
      makeTask({ id: 'a', order: 0, dueDate: now + 1 * MS_PER_DAY }),
      makeTask({ id: 'b', order: 1, starred: true }),
    ];
    const sorted = sortTasksForDisplay(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('starred + due-soon task stays in starred tier', () => {
    const now = Date.now();
    const tasks = [
      makeTask({ id: 'a', order: 0, dueDate: now + 1 * MS_PER_DAY }),
      makeTask({ id: 'b', order: 1, starred: true, dueDate: now + 3 * MS_PER_DAY }),
      makeTask({ id: 'c', order: 2 }),
    ];
    const sorted = sortTasksForDisplay(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('tasks with dueDate > 7 days stay in normal tier', () => {
    const now = Date.now();
    const tasks = [
      makeTask({ id: 'a', order: 0 }),
      makeTask({ id: 'b', order: 1, dueDate: now + 10 * MS_PER_DAY }),
      makeTask({ id: 'c', order: 2 }),
    ];
    const sorted = sortTasksForDisplay(tasks);
    // b has dueDate > 7 days, so sorted by order: a(0), b(1), c(2)
    expect(sorted.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('tasks with no dueDate stay in manual order', () => {
    const tasks = [
      makeTask({ id: 'c', order: 2 }),
      makeTask({ id: 'a', order: 0 }),
      makeTask({ id: 'b', order: 1 }),
    ];
    const sorted = sortTasksForDisplay(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('preserves manual order within same tier', () => {
    const tasks = [
      makeTask({ id: 'a', order: 2 }),
      makeTask({ id: 'b', order: 0 }),
      makeTask({ id: 'c', order: 1 }),
    ];
    const sorted = sortTasksForDisplay(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate original array', () => {
    const tasks = [
      makeTask({ id: 'b', order: 1, starred: true }),
      makeTask({ id: 'a', order: 0 }),
    ];
    const original = [...tasks];
    sortTasksForDisplay(tasks);
    expect(tasks.map((t) => t.id)).toEqual(original.map((t) => t.id));
  });
});

describe('sortFollowUpsForDisplay', () => {
  it('puts starred tasks first', () => {
    const tasks = [
      makeTask({ id: 'a', order: 0 }),
      makeTask({ id: 'b', order: 1, starred: true }),
      makeTask({ id: 'c', order: 2 }),
    ];
    const sorted = sortFollowUpsForDisplay(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('puts snoozed (in cooldown) tasks last', () => {
    const now = Date.now();
    const tasks = [
      makeTask({ id: 'a', order: 0, pingedAt: now, pingCooldown: '1week' }),
      makeTask({ id: 'b', order: 1 }),
      makeTask({ id: 'c', order: 2 }),
    ];
    const sorted = sortFollowUpsForDisplay(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('starred snoozed task goes to top', () => {
    const now = Date.now();
    const tasks = [
      makeTask({ id: 'a', order: 0 }),
      makeTask({ id: 'b', order: 1, starred: true, pingedAt: now, pingCooldown: '1week' }),
      makeTask({ id: 'c', order: 2 }),
    ];
    const sorted = sortFollowUpsForDisplay(tasks);
    expect(sorted.map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('preserves manual order within each tier', () => {
    const now = Date.now();
    const tasks = [
      makeTask({ id: 'a', order: 0, pingedAt: now, pingCooldown: '1week' }),
      makeTask({ id: 'b', order: 1 }),
      makeTask({ id: 'c', order: 2, pingedAt: now, pingCooldown: '12h' }),
      makeTask({ id: 'd', order: 3 }),
    ];
    const sorted = sortFollowUpsForDisplay(tasks);
    // Not snoozed by order: b(1), d(3) then snoozed by order: a(0), c(2)
    expect(sorted.map((t) => t.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('does not mutate original array', () => {
    const now = Date.now();
    const tasks = [
      makeTask({ id: 'a', order: 0, pingedAt: now, pingCooldown: '1week' }),
      makeTask({ id: 'b', order: 1 }),
    ];
    const original = [...tasks];
    sortFollowUpsForDisplay(tasks);
    expect(tasks.map((t) => t.id)).toEqual(original.map((t) => t.id));
  });
});
