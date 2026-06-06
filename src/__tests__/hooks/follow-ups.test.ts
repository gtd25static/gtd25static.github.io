import { isInCooldown, cooldownRemaining, cooldownUntil, formatCooldown, cadenceMs, applyDiscussed, isAwake } from '../../hooks/use-follow-ups';
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

  it('handles custom cooldown wake timestamps', () => {
    const task = makeTask({
      pingedAt: Date.now(),
      pingCooldown: 'custom',
      pingCooldownUntil: Date.now() + 5000,
    });
    expect(isInCooldown(task)).toBe(true);
  });

  it('ignores unreasonable custom cooldown values', () => {
    const task = makeTask({
      pingedAt: Date.now(),
      pingCooldown: 'custom',
      pingCooldownCustomMs: Number.MAX_SAFE_INTEGER,
    });
    expect(isInCooldown(task)).toBe(false);
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

  it('returns remaining ms for custom wake timestamps', () => {
    const task = makeTask({
      pingedAt: Date.now(),
      pingCooldown: 'custom',
      pingCooldownUntil: Date.now() + 3 * 60 * 60 * 1000,
    });
    expect(cooldownRemaining(task)).toBe(3 * 60 * 60 * 1000);
  });
});

describe('cooldownUntil', () => {
  it('uses pingCooldownUntil for custom cooldowns', () => {
    const until = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const task = makeTask({
      pingedAt: Date.now(),
      pingCooldown: 'custom',
      pingCooldownUntil: until,
      pingCooldownCustomMs: 5000,
    });

    expect(cooldownUntil(task)).toBe(until);
  });

  it('treats legacy absolute pingCooldownCustomMs as a wake timestamp', () => {
    const until = Date.now() + 4 * 60 * 60 * 1000;
    const task = makeTask({
      pingedAt: Date.now(),
      pingCooldown: 'custom',
      pingCooldownCustomMs: until,
    });

    expect(cooldownUntil(task)).toBe(until);
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

const WEEK = 7 * 24 * 60 * 60 * 1000;
const MONTH = 30 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

describe('cadenceMs', () => {
  it('uses a preset snoozeCadence', () => {
    expect(cadenceMs(makeTask({ snoozeCadence: '1month' }))).toBe(MONTH);
  });

  it('resolves the current preset cadences', () => {
    expect(cadenceMs(makeTask({ snoozeCadence: '20h' }))).toBe(20 * 60 * 60 * 1000);
    expect(cadenceMs(makeTask({ snoozeCadence: '6d' }))).toBe(6 * DAY);
    expect(cadenceMs(makeTask({ snoozeCadence: '30d' }))).toBe(30 * DAY);
    expect(cadenceMs(makeTask({ snoozeCadence: '12w' }))).toBe(12 * 7 * DAY);
  });

  it('uses custom cadence days', () => {
    expect(cadenceMs(makeTask({ snoozeCadence: 'custom', snoozeCadenceDays: 10 }))).toBe(10 * DAY);
  });

  it('falls back to the last pingCooldown when no cadence set', () => {
    expect(cadenceMs(makeTask({ pingCooldown: '1week' }))).toBe(WEEK);
  });

  it('defaults to 1 week when nothing is set', () => {
    expect(cadenceMs(makeTask())).toBe(WEEK);
  });

  it('ignores a custom cadence with no/invalid days and falls back', () => {
    expect(cadenceMs(makeTask({ snoozeCadence: 'custom' }))).toBe(WEEK);
  });
});

describe('applyDiscussed', () => {
  it('appends a log entry and re-snoozes for the cadence', () => {
    const task = makeTask({ snoozeCadence: '1month' });
    const update = applyDiscussed(task, '  spoke to the team  ');

    expect(update.discussionLog).toHaveLength(1);
    expect(update.discussionLog![0].at).toBe(Date.now());
    expect(update.discussionLog![0].note).toBe('spoke to the team'); // trimmed
    expect(update.discussionLog![0].id).toBeTruthy();
    expect(update.pingedAt).toBe(Date.now());
    expect(update.pingCooldown).toBe('custom');
    expect(update.pingCooldownUntil).toBe(Date.now() + MONTH);
  });

  it('preserves prior log entries (append, not replace)', () => {
    const task = makeTask({ discussionLog: [{ id: 'old', at: 5, note: 'first' }] });
    const update = applyDiscussed(task);
    expect(update.discussionLog).toHaveLength(2);
    expect(update.discussionLog![0].id).toBe('old');
    expect(update.discussionLog![1].note).toBeUndefined(); // empty note omitted
  });

  it('omits an empty/whitespace note', () => {
    const update = applyDiscussed(makeTask(), '   ');
    expect(update.discussionLog![0].note).toBeUndefined();
  });

  it('snoozes until an explicit untilMs (custom date) instead of the cadence', () => {
    const until = Date.now() + 5 * DAY;
    const update = applyDiscussed(makeTask({ snoozeCadence: '1month' }), 'met up', { untilMs: until });
    expect(update.pingCooldown).toBe('custom');
    expect(update.pingCooldownUntil).toBe(until);
    expect(update.discussionLog).toHaveLength(1);
  });
});

describe('isAwake', () => {
  it('is true for a fresh follow-up', () => {
    expect(isAwake(makeTask())).toBe(true);
  });

  it('is false while snoozed', () => {
    expect(isAwake(makeTask({ pingedAt: Date.now(), pingCooldown: '12h' }))).toBe(false);
  });

  it('is false when resolved (archived)', () => {
    expect(isAwake(makeTask({ archived: true }))).toBe(false);
  });

  it('is false when deleted', () => {
    expect(isAwake(makeTask({ deletedAt: Date.now() }))).toBe(false);
  });
});
