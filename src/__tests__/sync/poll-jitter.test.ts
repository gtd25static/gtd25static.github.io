import { describe, it, expect, vi, afterEach } from 'vitest';

// Toggle Paranoid Mode by flipping this flag (the helper reads it through the mock).
let paranoid = false;
vi.mock('../../db/paranoid-flag', () => ({
  isParanoidFlagSet: () => paranoid,
  PARANOID_FLAG: 'gtd25-paranoid',
}));

import { jitterInterval } from '../../sync/poll-jitter';

afterEach(() => { paranoid = false; });

describe('jitterInterval', () => {
  it('returns the base interval unchanged when not paranoid', () => {
    paranoid = false;
    for (let i = 0; i < 50; i++) expect(jitterInterval(30_000)).toBe(30_000);
  });

  it('spreads ±30% around the base in Paranoid Mode and actually varies', () => {
    paranoid = true;
    const base = 30_000;
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const v = jitterInterval(base);
      expect(v).toBeGreaterThanOrEqual(Math.round(base * 0.7));
      expect(v).toBeLessThanOrEqual(Math.round(base * 1.3));
      seen.add(v);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('never returns below 1ms', () => {
    paranoid = true;
    for (let i = 0; i < 50; i++) expect(jitterInterval(0)).toBeGreaterThanOrEqual(1);
  });
});
