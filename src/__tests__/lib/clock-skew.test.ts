import { vi } from 'vitest';

const mockRecordError = vi.fn();
vi.mock('../../lib/diagnostics', () => ({ recordError: (...a: unknown[]) => mockRecordError(...a) }));

import {
  recordServerDate, getClockSkewMs, isClockSkewed, formatSkew, SKEW_WARN_MS, __resetClockSkewForTests,
} from '../../lib/clock-skew';

const SERVER = 'Mon, 27 Jul 2026 12:00:00 GMT';
const serverMs = Date.parse(SERVER);

beforeEach(() => {
  __resetClockSkewForTests();
  mockRecordError.mockClear();
});

describe('recordServerDate', () => {
  it('measures how far this device is from the server', () => {
    expect(recordServerDate(SERVER, serverMs + 2_000)).toBe(2_000);   // ahead
    expect(recordServerDate(SERVER, serverMs - 2_000)).toBe(-2_000);  // behind
    expect(getClockSkewMs()).toBe(-2_000);
  });

  it('ignores a missing or unparseable header', () => {
    expect(recordServerDate(null)).toBeNull();
    expect(recordServerDate(undefined)).toBeNull();
    expect(recordServerDate('not a date')).toBeNull();
    expect(getClockSkewMs()).toBeNull();
  });

  it('treats round-trip noise as fine, and a real drift as skewed', () => {
    recordServerDate(SERVER, serverMs + 3_000);
    expect(isClockSkewed()).toBe(false);
    expect(mockRecordError).not.toHaveBeenCalled();

    recordServerDate(SERVER, serverMs + SKEW_WARN_MS + 1);
    expect(isClockSkewed()).toBe(true);
  });

  it('records a diagnostic naming the direction and the size', () => {
    recordServerDate(SERVER, serverMs + 3 * 60 * 60_000); // 3 h ahead
    expect(mockRecordError).toHaveBeenCalledTimes(1);
    const [context, err] = mockRecordError.mock.calls[0] as [string, Error];
    expect(context).toBe('clock.skew');
    expect(err.message).toContain('ahead of');
    expect(err.message).toContain('3 h');

    mockRecordError.mockClear();
    recordServerDate(SERVER, serverMs - 3 * 60 * 60_000); // 3 h behind
    expect((mockRecordError.mock.calls[0] as [string, Error])[1].message).toContain('behind');
  });

  it('does not spam the log while the skew stays put', () => {
    const skewed = serverMs + 30 * 60_000;
    recordServerDate(SERVER, skewed);
    recordServerDate(SERVER, skewed + 1_000);
    recordServerDate(SERVER, skewed + 2_000);
    expect(mockRecordError).toHaveBeenCalledTimes(1);

    // …but a materially different reading is worth reporting again.
    recordServerDate(SERVER, serverMs + 120 * 60_000);
    expect(mockRecordError).toHaveBeenCalledTimes(2);
  });

  it('re-reports after the clock comes back and drifts again', () => {
    recordServerDate(SERVER, serverMs + 30 * 60_000);
    expect(mockRecordError).toHaveBeenCalledTimes(1);
    recordServerDate(SERVER, serverMs);                   // fixed
    expect(isClockSkewed()).toBe(false);
    recordServerDate(SERVER, serverMs + 30 * 60_000);     // broke again
    expect(mockRecordError).toHaveBeenCalledTimes(2);
  });
});

describe('formatSkew', () => {
  it('reads in the unit that makes the problem obvious', () => {
    expect(formatSkew(6 * 60_000)).toBe('6 min');
    expect(formatSkew(3 * 60 * 60_000)).toBe('3 h');
    expect(formatSkew(72 * 60 * 60_000)).toBe('3 days');
  });
});
