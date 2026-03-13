import { pickMotivationMessage } from '../../lib/motivation-messages';
import type { MotivationStats } from '../../hooks/use-motivation-stats';

function makeStats(overrides: Partial<MotivationStats> = {}): MotivationStats {
  return {
    completedToday: 0,
    completedThisWeek: 0,
    completedThisMonth: 0,
    streakDays: 0,
    overdueCount: 0,
    blockedCount: 0,
    totalActive: 5,
    isCurrentlyWorking: false,
    isWeekend: false,
    timeOfDay: 'afternoon',
    ...overrides,
  };
}

const fixedRng = () => 0;

describe('pickMotivationMessage', () => {
  it('weekend + no completions → weekend category', () => {
    const stats = makeStats({ isWeekend: true });
    const msg = pickMotivationMessage(stats, fixedRng);
    expect(msg).not.toBeNull();
    expect(msg!.category).toBe('weekend');
  });

  it('weekend + completions → normal category (not weekend)', () => {
    const stats = makeStats({ isWeekend: true, completedToday: 3 });
    const msg = pickMotivationMessage(stats, fixedRng);
    expect(msg).not.toBeNull();
    expect(msg!.category).not.toBe('weekend');
    expect(msg!.category).toBe('productive_day');
  });

  it('weekday + no completions + afternoon → idle_nudge', () => {
    const stats = makeStats({ timeOfDay: 'afternoon', blockedCount: 1 });
    const msg = pickMotivationMessage(stats, fixedRng);
    expect(msg).not.toBeNull();
    expect(msg!.category).toBe('idle_nudge');
  });

  it('weekend + no completions + afternoon → weekend, not idle_nudge', () => {
    const stats = makeStats({ isWeekend: true, timeOfDay: 'afternoon' });
    const msg = pickMotivationMessage(stats, fixedRng);
    expect(msg).not.toBeNull();
    expect(msg!.category).toBe('weekend');
  });

  it('weekend + no completions + morning → weekend, not fresh_start', () => {
    const stats = makeStats({ isWeekend: true, timeOfDay: 'morning' });
    const msg = pickMotivationMessage(stats, fixedRng);
    expect(msg).not.toBeNull();
    expect(msg!.category).toBe('weekend');
  });

  it('weekday + no completions + morning → fresh_start', () => {
    const stats = makeStats({ timeOfDay: 'morning', blockedCount: 1 });
    const msg = pickMotivationMessage(stats, fixedRng);
    expect(msg).not.toBeNull();
    expect(msg!.category).toBe('fresh_start');
  });
});
