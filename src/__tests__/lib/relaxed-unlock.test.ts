import {
  computeUnlockMultiplier, unlocksInWindow, effectiveMinutes, pruneHistory,
  RELAXED_MAX_MULTIPLIER,
} from '../../lib/relaxed-unlock';

const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

// n unlock timestamps, all within the last hour (so they count toward 36h).
const recent = (n: number) => Array.from({ length: n }, (_, i) => NOW - (i + 1) * 60_000);

describe('computeUnlockMultiplier', () => {
  it('first unlock is the baseline (no bump), then +10% per additional unlock', () => {
    expect(computeUnlockMultiplier([], NOW)).toBe(1.0);
    expect(computeUnlockMultiplier(recent(1), NOW)).toBe(1.0); // first unlock: no bump
    expect(computeUnlockMultiplier(recent(2), NOW)).toBeCloseTo(1.1, 5);
    expect(computeUnlockMultiplier(recent(6), NOW)).toBeCloseTo(1.5, 5);
  });

  it('caps at ×2 (eleven unlocks = +100%) and never exceeds it', () => {
    expect(computeUnlockMultiplier(recent(11), NOW)).toBeCloseTo(2.0, 5);
    expect(computeUnlockMultiplier(recent(20), NOW)).toBe(RELAXED_MAX_MULTIPLIER);
    expect(computeUnlockMultiplier(recent(100), NOW)).toBe(RELAXED_MAX_MULTIPLIER);
  });

  it('is non-decreasing in the unlock count', () => {
    let prev = 0;
    for (let n = 0; n <= 15; n++) {
      const m = computeUnlockMultiplier(recent(n), NOW);
      expect(m).toBeGreaterThanOrEqual(prev);
      expect(m).toBeLessThanOrEqual(RELAXED_MAX_MULTIPLIER);
      prev = m;
    }
  });

  it('only counts unlocks within the last 36h', () => {
    const history = [
      NOW - 1 * HOUR,   // in
      NOW - 35 * HOUR,  // in (within 36h)
      NOW - 37 * HOUR,  // out (older than 36h)
      NOW - 48 * HOUR,  // out
    ];
    expect(unlocksInWindow(history, NOW)).toBe(2);   // → 1 additional → ×1.10
    expect(computeUnlockMultiplier(history, NOW)).toBeCloseTo(1.1, 5);
  });

  it('counts regardless of order and ignores future timestamps', () => {
    expect(unlocksInWindow([NOW - 3 * HOUR, NOW - 1 * HOUR, NOW - 2 * HOUR], NOW)).toBe(3);
    expect(unlocksInWindow([NOW + 5 * HOUR], NOW)).toBe(0); // clock-skew guard
  });
});

describe('pruneHistory', () => {
  it('drops timestamps older than 36h and any in the future', () => {
    const history = [NOW - 1 * HOUR, NOW - 25 * HOUR, NOW - 37 * HOUR, NOW + HOUR, NOW - 12 * HOUR];
    expect(pruneHistory(history, NOW)).toEqual([NOW - 1 * HOUR, NOW - 25 * HOUR, NOW - 12 * HOUR]);
  });
});

describe('effectiveMinutes', () => {
  it('rounds base × multiplier and clamps to the absolute max', () => {
    expect(effectiveMinutes(15, 1.0, 240)).toBe(15);
    expect(effectiveMinutes(15, 1.5, 240)).toBe(23); // 22.5 → 23
    expect(effectiveMinutes(15, 2.0, 240)).toBe(30);
    expect(effectiveMinutes(200, 2.0, 240)).toBe(240); // 400 clamped to 240
    expect(effectiveMinutes(10, 2.0, 60)).toBe(20);
    expect(effectiveMinutes(40, 2.0, 60)).toBe(60); // 80 clamped to 60
  });
});
