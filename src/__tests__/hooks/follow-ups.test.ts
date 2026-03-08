import { isInCooldown, cooldownRemaining, formatCooldown } from '../../hooks/use-follow-ups';
import type { Task } from '../../db/models';

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 't1', listId: 'l1', title: 'Task', status: 'todo', order: 0,
    createdAt: 1000, updatedAt: 1000, ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-08T12:00:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isInCooldown', () => {
  it('returns false when no ping', () => {
    expect(isInCooldown(makeTask())).toBe(false);
  });

  it('returns true within cooldown window', () => {
    const task = makeTask({
      pingedAt: Date.now() - 1000, // 1 second ago
      pingCooldown: '12h',
    });
    expect(isInCooldown(task)).toBe(true);
  });

  it('returns false when cooldown elapsed', () => {
    const task = makeTask({
      pingedAt: Date.now() - 13 * 60 * 60 * 1000, // 13 hours ago
      pingCooldown: '12h',
    });
    expect(isInCooldown(task)).toBe(false);
  });

  it('handles custom cooldown', () => {
    const task = makeTask({
      pingedAt: Date.now() - 1000,
      pingCooldown: 'custom',
      pingCooldownCustomMs: 5000,
    });
    expect(isInCooldown(task)).toBe(true);
  });
});

describe('cooldownRemaining', () => {
  it('returns 0 when no ping', () => {
    expect(cooldownRemaining(makeTask())).toBe(0);
  });

  it('returns remaining ms when in cooldown', () => {
    const task = makeTask({
      pingedAt: Date.now() - 1000,
      pingCooldown: '12h',
    });
    const remaining = cooldownRemaining(task);
    // 12h = 43200000ms, minus 1000ms elapsed
    expect(remaining).toBe(43200000 - 1000);
  });

  it('returns 0 when cooldown elapsed', () => {
    const task = makeTask({
      pingedAt: Date.now() - 50 * 60 * 60 * 1000,
      pingCooldown: '12h',
    });
    expect(cooldownRemaining(task)).toBe(0);
  });
});

describe('formatCooldown', () => {
  it('formats hours when less than 24h', () => {
    expect(formatCooldown(5 * 60 * 60 * 1000)).toBe('5h');
  });

  it('formats days when 24h or more', () => {
    expect(formatCooldown(3 * 24 * 60 * 60 * 1000)).toBe('3d');
  });
});
