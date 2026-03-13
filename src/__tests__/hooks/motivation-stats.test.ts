import { computeStreak, isWeekend } from '../../hooks/use-motivation-stats';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function dayTs(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00`).getTime();
}

describe('isWeekend', () => {
  it('returns true for Saturday', () => {
    expect(isWeekend(new Date('2026-03-14T12:00:00'))).toBe(true); // Saturday
  });

  it('returns true for Sunday', () => {
    expect(isWeekend(new Date('2026-03-15T12:00:00'))).toBe(true); // Sunday
  });

  it('returns false for weekdays', () => {
    expect(isWeekend(new Date('2026-03-09T12:00:00'))).toBe(false); // Monday
    expect(isWeekend(new Date('2026-03-13T12:00:00'))).toBe(false); // Friday
  });
});

describe('computeStreak', () => {
  it('weekday streak Mon-Fri = 5', () => {
    // 2026-03-13 is a Friday
    vi.setSystemTime(new Date('2026-03-13T14:00:00'));
    const dates = [
      dayTs('2026-03-09'), // Mon
      dayTs('2026-03-10'), // Tue
      dayTs('2026-03-11'), // Wed
      dayTs('2026-03-12'), // Thu
      dayTs('2026-03-13'), // Fri
    ];
    expect(computeStreak(dates)).toBe(5);
  });

  it('streak across weekend: Thu+Fri+Mon = 3', () => {
    // 2026-03-16 is a Monday
    vi.setSystemTime(new Date('2026-03-16T14:00:00'));
    const dates = [
      dayTs('2026-03-12'), // Thu
      dayTs('2026-03-13'), // Fri
      dayTs('2026-03-16'), // Mon
    ];
    expect(computeStreak(dates)).toBe(3);
  });

  it('broken by missing weekday: Mon+Wed (no Tue) = 1', () => {
    // 2026-03-11 is a Wednesday
    vi.setSystemTime(new Date('2026-03-11T14:00:00'));
    const dates = [
      dayTs('2026-03-09'), // Mon
      dayTs('2026-03-11'), // Wed
    ];
    expect(computeStreak(dates)).toBe(1);
  });

  it('viewed on Saturday shows Friday streak', () => {
    // 2026-03-14 is a Saturday
    vi.setSystemTime(new Date('2026-03-14T14:00:00'));
    const dates = [
      dayTs('2026-03-12'), // Thu
      dayTs('2026-03-13'), // Fri
    ];
    expect(computeStreak(dates)).toBe(2);
  });

  it('no completions returns 0', () => {
    vi.setSystemTime(new Date('2026-03-13T14:00:00'));
    expect(computeStreak([])).toBe(0);
  });

  it('viewed on Sunday shows Friday streak', () => {
    // 2026-03-15 is a Sunday
    vi.setSystemTime(new Date('2026-03-15T14:00:00'));
    const dates = [
      dayTs('2026-03-13'), // Fri
    ];
    expect(computeStreak(dates)).toBe(1);
  });

  it('streak not broken by weekend-only gap', () => {
    // Fri completed, then Mon completed — streak = 2
    vi.setSystemTime(new Date('2026-03-16T14:00:00')); // Mon
    const dates = [
      dayTs('2026-03-13'), // Fri
      dayTs('2026-03-16'), // Mon
    ];
    expect(computeStreak(dates)).toBe(2);
  });
});
