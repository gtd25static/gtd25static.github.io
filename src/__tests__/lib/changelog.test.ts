import { changelogFor, parseVersionInfo, type VersionInfo } from '../../lib/changelog';

describe('changelogFor', () => {
  const log = [
    { h: 'c3', s: 'third' },
    { h: 'c2', s: 'second' },
    { h: 'c1', s: 'first' },
    { h: 'c0', s: 'base' },
  ];

  it('returns only commits newer than the current one (stops at current)', () => {
    const info: VersionInfo = { commit: 'c3', message: 'third', log };
    expect(changelogFor(info, 'c1')).toEqual([
      { h: 'c3', s: 'third' },
      { h: 'c2', s: 'second' },
    ]);
  });

  it('returns nothing when current is already the newest', () => {
    expect(changelogFor({ commit: 'c3', message: 'third', log }, 'c3')).toEqual([]);
  });

  it('falls back to the full window when current is not in the log', () => {
    expect(changelogFor({ commit: 'c3', message: 'third', log }, 'unknown')).toEqual(log);
  });

  it('falls back to the headline commit when there is no log', () => {
    expect(changelogFor({ commit: 'c3', message: 'headline' }, 'old')).toEqual([{ h: 'c3', s: 'headline' }]);
  });

  it('returns empty when there is neither log nor message', () => {
    expect(changelogFor({ commit: 'c3', message: '' }, 'old')).toEqual([]);
  });
});

describe('parseVersionInfo', () => {
  it('parses a well-formed payload', () => {
    const v = parseVersionInfo({ commit: 'abc', message: 'hi', builtAt: '2026-01-01', log: [{ h: 'abc', s: 'hi' }] });
    expect(v).toEqual({ commit: 'abc', message: 'hi', builtAt: '2026-01-01', log: [{ h: 'abc', s: 'hi' }] });
  });

  it('rejects payloads without a commit', () => {
    expect(parseVersionInfo({ message: 'x' })).toBeNull();
    expect(parseVersionInfo(null)).toBeNull();
    expect(parseVersionInfo('nope')).toBeNull();
    expect(parseVersionInfo({ commit: '' })).toBeNull();
  });

  it('drops malformed log entries and a non-array log', () => {
    const v = parseVersionInfo({ commit: 'abc', log: [{ h: 'ok', s: 'ok' }, { h: 1, s: 'bad' }, null, 'x'] });
    expect(v?.log).toEqual([{ h: 'ok', s: 'ok' }]);
    expect(parseVersionInfo({ commit: 'abc', log: 'not-array' })?.log).toBeUndefined();
  });

  it('defaults a missing/non-string message to empty', () => {
    expect(parseVersionInfo({ commit: 'abc' })?.message).toBe('');
    expect(parseVersionInfo({ commit: 'abc', message: 42 })?.message).toBe('');
  });
});
