import { daysUntil, isDueSoon, dueDateColor, formatDate, toInputDate, fromInputDate, formatTimeRemaining } from '../../lib/date-utils';

const PINNED = new Date('2026-03-08T12:00:00').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(PINNED);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('daysUntil', () => {
  it('returns 0 for today', () => {
    expect(daysUntil(PINNED)).toBe(0);
  });

  it('returns positive for future dates', () => {
    const future = new Date('2026-03-15T00:00:00').getTime();
    expect(daysUntil(future)).toBe(7);
  });

  it('returns negative for past dates', () => {
    const past = new Date('2026-03-01T00:00:00').getTime();
    expect(daysUntil(past)).toBe(-7);
  });

  it('ignores time-of-day', () => {
    const earlyMorning = new Date('2026-03-09T03:00:00').getTime();
    const lateNight = new Date('2026-03-09T23:59:59').getTime();
    expect(daysUntil(earlyMorning)).toBe(1);
    expect(daysUntil(lateNight)).toBe(1);
  });
});

describe('isDueSoon', () => {
  it('returns false for undefined', () => {
    expect(isDueSoon(undefined)).toBe(false);
  });

  it('returns true for dates within 14 days', () => {
    const soon = new Date('2026-03-22T00:00:00').getTime(); // 14 days
    expect(isDueSoon(soon)).toBe(true);
  });

  it('returns false for dates beyond 14 days', () => {
    const far = new Date('2026-03-23T00:00:00').getTime(); // 15 days
    expect(isDueSoon(far)).toBe(false);
  });
});

describe('dueDateColor', () => {
  it('returns red for overdue', () => {
    const past = new Date('2026-03-07T00:00:00').getTime();
    expect(dueDateColor(past)).toBe('text-red-500');
  });

  it('returns orange for 0-3 days', () => {
    expect(dueDateColor(PINNED)).toBe('text-orange-500');
    const threeDays = new Date('2026-03-11T00:00:00').getTime();
    expect(dueDateColor(threeDays)).toBe('text-orange-500');
  });

  it('returns yellow for 4-14 days', () => {
    const fiveDays = new Date('2026-03-13T00:00:00').getTime();
    expect(dueDateColor(fiveDays)).toBe('text-yellow-500');
  });

  it('returns zinc for >14 days', () => {
    const far = new Date('2026-03-23T00:00:00').getTime();
    expect(dueDateColor(far)).toBe('text-zinc-400');
  });
});

describe('formatDate', () => {
  it('returns DD/MM for current year', () => {
    const ts = new Date('2026-03-15T00:00:00').getTime();
    expect(formatDate(ts)).toBe('15/03');
  });

  it('returns DD/MM/YYYY for different year', () => {
    const ts = new Date('2025-12-25T00:00:00').getTime();
    expect(formatDate(ts)).toBe('25/12/2025');
  });
});

describe('toInputDate', () => {
  it('converts timestamp to YYYY-MM-DD', () => {
    const ts = new Date('2026-03-08T00:00:00').getTime();
    expect(toInputDate(ts)).toBe('2026-03-08');
  });
});

describe('fromInputDate', () => {
  it('parses valid YYYY-MM-DD to timestamp', () => {
    const result = fromInputDate('2026-03-08');
    expect(result).toBeDefined();
    const d = new Date(result!);
    expect(d.getDate()).toBe(8);
    expect(d.getMonth()).toBe(2); // March = 2
    expect(d.getFullYear()).toBe(2026);
  });

  it('returns undefined for invalid input', () => {
    expect(fromInputDate('not-a-date')).toBeUndefined();
    expect(fromInputDate('08/03/2026')).toBeUndefined();
  });
});

describe('formatTimeRemaining', () => {
  it('returns "now" for past timestamps', () => {
    expect(formatTimeRemaining(PINNED - 1000)).toBe('now');
  });

  it('returns hours for <24h', () => {
    const fiveHours = PINNED + 5 * 60 * 60 * 1000;
    expect(formatTimeRemaining(fiveHours)).toBe('5h');
  });

  it('returns days for <7d', () => {
    const threeDays = PINNED + 3 * 24 * 60 * 60 * 1000;
    expect(formatTimeRemaining(threeDays)).toBe('3d');
  });

  it('returns weeks for <5w', () => {
    const twoWeeks = PINNED + 14 * 24 * 60 * 60 * 1000;
    expect(formatTimeRemaining(twoWeeks)).toBe('2w');
  });

  it('returns months for longer periods', () => {
    const threeMonths = PINNED + 90 * 24 * 60 * 60 * 1000;
    expect(formatTimeRemaining(threeMonths)).toBe('3mo');
  });
});
