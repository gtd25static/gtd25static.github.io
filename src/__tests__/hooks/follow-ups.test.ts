import { isInCooldown, cooldownRemaining, cooldownUntil, formatCooldown, cadenceMs, cadenceLabel, applyDiscussed, lastDiscussedAt, nextWakeAt, resolvedAt, topicAgeLine } from '../../hooks/use-follow-ups';
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

  // It said "0h left" for the whole last hour.
  it('formats minutes under an hour, never "0"', () => {
    expect(formatCooldown(59 * 60 * 1000 + 30_000)).toBe('59m');
    expect(formatCooldown(30 * 60 * 1000)).toBe('30m');
    expect(formatCooldown(20_000)).toBe('1m');
  });
});

// The chip under a follow-up that says how often it comes back.
describe('cadenceLabel', () => {
  const HOUR = 60 * 60 * 1000;
  const D = 24 * HOUR;

  it('shows the 20h preset as 20h (it said "every 1d")', () => {
    expect(cadenceLabel(20 * HOUR)).toBe('every 20h');
    expect(cadenceLabel(12 * HOUR)).toBe('every 12h');
  });

  it('shows whole weeks as weeks, including 12 weeks (it said "every 3mo")', () => {
    expect(cadenceLabel(7 * D)).toBe('every 1w');
    expect(cadenceLabel(12 * 7 * D)).toBe('every 12w');
  });

  it('shows days and months', () => {
    expect(cadenceLabel(6 * D)).toBe('every 6d');
    expect(cadenceLabel(11 * D)).toBe('every 11d');
    expect(cadenceLabel(30 * D)).toBe('every 1mo');
    expect(cadenceLabel(90 * D)).toBe('every 3mo');
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
  it('re-snoozes for the cadence and leaves the discussion log alone', () => {
    const task = makeTask({ snoozeCadence: '1month', discussionLog: [{ id: 'old', at: 5, note: 'first' }] });
    const update = applyDiscussed(task);

    expect(update.pingedAt).toBe(Date.now());
    expect(update.pingCooldown).toBe('custom');
    expect(update.pingCooldownUntil).toBe(Date.now() + MONTH);
    expect('discussionLog' in update).toBe(false);
  });

  it('snoozes until an explicit untilMs (custom date) instead of the cadence', () => {
    const until = Date.now() + 5 * DAY;
    const update = applyDiscussed(makeTask({ snoozeCadence: '1month' }), { untilMs: until });
    expect(update.pingCooldown).toBe('custom');
    expect(update.pingCooldownUntil).toBe(until);
  });
});

describe('lastDiscussedAt', () => {
  it('is the newest note or Discussed snooze, else the creation', () => {
    expect(lastDiscussedAt(makeTask({ createdAt: 1000 }))).toBe(1000);
    expect(lastDiscussedAt(makeTask({ createdAt: 1000, pingedAt: 4000 }))).toBe(4000);
    expect(lastDiscussedAt(makeTask({
      createdAt: 1000,
      pingedAt: 4000,
      discussionLog: [{ id: 'a', at: 2000 }, { id: 'b', at: 6000 }],
    }))).toBe(6000);
  });

  it('skips entries whose time is not a number (synced data)', () => {
    const task = makeTask({ createdAt: 1000, discussionLog: [{ id: 'a', at: Number.NaN }, { id: 'b', at: 'x' as unknown as number }] });
    expect(lastDiscussedAt(task)).toBe(1000);
  });
});

describe('nextWakeAt', () => {
  it('is the soonest wake among the snoozed, 0 when none is snoozed', () => {
    const now = Date.now();
    expect(nextWakeAt([makeTask(), makeTask({ pingedAt: now - 30 * DAY, pingCooldown: '6d' })])).toBe(0);
    expect(nextWakeAt([
      makeTask({ id: 'a', pingedAt: now, pingCooldown: 'custom', pingCooldownUntil: now + 5000 }),
      makeTask({ id: 'b', pingedAt: now, pingCooldown: 'custom', pingCooldownUntil: now + 2000 }),
      makeTask({ id: 'c' }),
    ])).toBe(now + 2000);
  });
});

describe('resolvedAt', () => {
  it('is when `archived` last changed, else when the topic last changed', () => {
    expect(resolvedAt(makeTask({ archived: true, updatedAt: 9000, fieldTimestamps: { archived: 5000 } }))).toBe(5000);
    expect(resolvedAt(makeTask({ archived: true, updatedAt: 9000 }))).toBe(9000);
  });
});

describe('topicAgeLine', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = () => Date.now();

  it('how long the topic has been open, and how often it gets a note', () => {
    const task = makeTask({
      createdAt: now() - 47 * DAY - 1000,
      discussionLog: [
        { id: 'a', at: now() - 20 * DAY },
        { id: 'c', at: now() - 4 * DAY },
        { id: 'b', at: now() - 12 * DAY },
      ],
    });
    expect(topicAgeLine(task)).toBe('Open 47 days · a note every ~8 days');
  });

  it('just the age with fewer than two notes; days in the singular; today', () => {
    expect(topicAgeLine(makeTask({ createdAt: now() - 47 * DAY, discussionLog: [{ id: 'a', at: now() }] }))).toBe('Open 47 days');
    expect(topicAgeLine(makeTask({ createdAt: now() - DAY - 1000 }))).toBe('Open 1 day');
    expect(topicAgeLine(makeTask({ createdAt: now() - 3 * 60 * 60 * 1000 }))).toBe('Opened today');
  });

  it('notes a day apart or closer read as about a note a day', () => {
    const task = makeTask({
      createdAt: now() - 10 * DAY,
      discussionLog: [{ id: 'a', at: now() - 2 * DAY }, { id: 'b', at: now() - DAY }, { id: 'c', at: now() - DAY + 1000 }],
    });
    expect(topicAgeLine(task)).toBe('Open 10 days · about a note a day');
  });

  it('a resolved topic counts up to when it was resolved', () => {
    expect(topicAgeLine(makeTask({ archived: true, createdAt: now() - 50 * DAY, fieldTimestamps: { archived: now() - 3 * DAY } })))
      .toBe('Was open 47 days');
    expect(topicAgeLine(makeTask({ archived: true, createdAt: now() - 50 * DAY, updatedAt: now() - 50 * DAY + 1000 })))
      .toBe('Resolved within a day');
  });

  // Synced data: a row without a usable creation time gets no line.
  it('nothing for a topic without a creation time', () => {
    expect(topicAgeLine(makeTask({ createdAt: Number.NaN }))).toBeNull();
    expect(topicAgeLine(makeTask({ createdAt: 'yesterday' as unknown as number }))).toBeNull();
  });
});
