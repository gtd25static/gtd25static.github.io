import { changelogFor, parseVersionInfo, fetchDeployedVersion, fetchDeployedChanges, type VersionInfo } from '../../lib/changelog';

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

describe('the deployed-build files', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the build id from version.json and the changelog from changes.json', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => ({ commit: 'abc', message: 'm', log: [{ h: 'abc', s: 'm' }] }) } as Response;
    }));
    expect((await fetchDeployedVersion())?.commit).toBe('abc');
    expect((await fetchDeployedChanges())?.log).toEqual([{ h: 'abc', s: 'm' }]);
    expect(urls[0]).toMatch(/\/version\.json\?t=\d+$/);
    expect(urls[1]).toMatch(/\/changes\.json\?t=\d+$/);
  });

  it('gives up on a file that never arrives instead of waiting forever', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      inits.push(init);
      return { ok: false } as Response;
    }));
    await fetchDeployedChanges();
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });
});
