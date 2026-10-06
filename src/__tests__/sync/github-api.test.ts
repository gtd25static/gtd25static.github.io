import { getFile, getBinaryFile, putBinaryFile, putFile, transferTimeoutMs, RateLimitError } from '../../sync/github-api';
import { getClockSkewMs, __resetClockSkewForTests } from '../../lib/clock-skew';

describe('RateLimitError', () => {
  it('has correct properties', () => {
    const resetAt = Date.now() + 60_000;
    const err = new RateLimitError(resetAt);
    expect(err.name).toBe('RateLimitError');
    expect(err.resetAtMs).toBe(resetAt);
    expect(err.message).toBe('GitHub API rate limit exceeded');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof RateLimitError).toBe(true);
  });
});

describe('getFile — files over 1 MB', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The Contents API returns `content: ""` with `encoding: "none"` for 1–100 MB
  // files; the bytes have to come from the git blob of the same sha.
  it('fetches the raw blob of the same sha when the contents response carries no content', async () => {
    const big = JSON.stringify({ tasks: 'x'.repeat(10) });
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      urls.push(url);
      if (url.endsWith('/git/blobs/blob-sha')) {
        expect((init.headers as Record<string, string>).Accept).toBe('application/vnd.github.raw');
        return Promise.resolve(new Response(big, { status: 200 }));
      }
      return Promise.resolve(new Response(
        JSON.stringify({ content: '', encoding: 'none', sha: 'blob-sha', size: 1_500_000 }),
        { status: 200 },
      ));
    }));

    const file = await getFile('tok', 'me/repo', 'gtd25-snapshot.json');
    expect(file).toEqual({ data: big, sha: 'blob-sha' });
    expect(urls[1]).toBe('https://api.github.com/repos/me/repo/git/blobs/blob-sha');
  });

  it('still returns an empty string for a genuinely empty file', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ content: '', encoding: 'base64', sha: 'e', size: 0 }),
      { status: 200 },
    ))));
    expect(await getFile('tok', 'me/repo', 'x.json')).toEqual({ data: '', sha: 'e' });
  });

  it('throws rather than returning empty data when the blob fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(url.includes('/git/blobs/')
      ? new Response(null, { status: 502 })
      : new Response(JSON.stringify({ content: '', encoding: 'none', sha: 's', size: 2_000_000 }), { status: 200 }))));
    await expect(getFile('tok', 'me/repo', 'gtd25-changelog.json')).rejects.toThrow(/502/);
  });
});

describe('request timeouts', () => {
  // A 15 s budget for every request aborted large shared files on slower links —
  // and each retry sent the whole file again. Transfers now get time in
  // proportion to their size; everything else keeps 15 s.
  let timeouts: number[];

  beforeEach(() => {
    timeouts = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { timeouts.push(ms); return real(ms); });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ content: { sha: 'new-sha' }, sha: 'file-sha', encoding: 'base64' }), { status: 200 },
    )));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('scales with size: about a second per 256 KiB on top of 15 s', () => {
    expect(transferTimeoutMs(0)).toBe(15_000);
    expect(transferTimeoutMs(262_143)).toBe(15_000);
    expect(transferTimeoutMs(262_144)).toBe(16_000);
    expect(transferTimeoutMs(42_000_000)).toBe(175_000);
  });

  it('gives a 2 MB upload more than 15 s', async () => {
    await putBinaryFile('tok', 'me/repo', 'gtd25-shared/x', new Uint8Array(2_000_000), undefined, undefined, 'b');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(15_000);
  });

  it('gives a download the time its caller asks for', async () => {
    await getBinaryFile('tok', 'me/repo', 'gtd25-shared/x', undefined, 'b', 90_000);
    expect(timeouts).toEqual([90_000]);
  });

  it('keeps 15 s for ordinary requests', async () => {
    await getBinaryFile('tok', 'me/repo', 'gtd25-shared/x');
    expect(timeouts).toEqual([15_000]);
  });

  it('gives a contents download the time its largest inline body (~1.4 MB) needs', async () => {
    await getFile('tok', 'me/repo', 'gtd25-changelog.json').catch(() => {}); // only the budget matters here
    expect(timeouts).toEqual([transferTimeoutMs(1_400_000)]);
    expect(timeouts[0]).toBeGreaterThan(15_000);
  });

  it('gives a snapshot over 1 MB the time its size needs — a fixed 15 s never finished on a slow link', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/git/blobs/')
      ? new Response('{}', { status: 200 })
      : new Response(JSON.stringify({ content: '', encoding: 'none', sha: 'big', size: 4_000_000 }), { status: 200 })));
    await getFile('tok', 'me/repo', 'gtd25-snapshot.json');
    expect(timeouts[1]).toBe(transferTimeoutMs(4_000_000));
  });
});

describe('rate limits and ambiguous creates', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Reliability review 2026-10-06 (B4): the pause added the clock skew to every
  // reset, though only X-RateLimit-Reset is on the server's clock: a device two
  // hours ahead paused two hours for a 2-minute Retry-After.
  it('gives every reset on this device\'s clock: Retry-After as is, X-RateLimit-Reset corrected for skew', async () => {
    const twoHours = 2 * 60 * 60 * 1000;
    const serverDate = new Date(Date.now() - twoHours).toUTCString(); // this device is 2 h ahead
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120', Date: serverDate } })));
    const before = Date.now();
    const retry = await getFile('tok', 'me/repo', 'x.json').catch((e) => e);
    expect(retry.resetAtMs).toBeGreaterThanOrEqual(before + 120_000);
    expect(retry.resetAtMs).toBeLessThan(before + 125_000);

    const serverReset = Math.floor((Date.now() - twoHours) / 1000) + 600; // in 10 min, server time
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(serverReset), Date: serverDate },
    })));
    const primary = await getFile('tok', 'me/repo', 'x.json').catch((e) => e);
    expect(primary.resetAtMs).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(primary.resetAtMs).toBeLessThan(Date.now() + 11 * 60_000);
  });

  it('treats a 429 as a rate limit, waiting what Retry-After says', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } })));
    const before = Date.now();
    const err = await getFile('tok', 'me/repo', 'x.json').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.resetAtMs).toBeGreaterThanOrEqual(before + 120_000);
  });

  it('treats a 403 secondary limit as a rate limit, not as a rejected token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }),
      { status: 403 },
    )));
    const err = await getFile('tok', 'me/repo', 'x.json').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.resetAtMs).toBeGreaterThan(Date.now());
  });

  it('treats a 403 with Retry-After as a rate limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403, headers: { 'Retry-After': '30' } })));
    expect(await getFile('tok', 'me/repo', 'x.json').catch((e) => e)).toBeInstanceOf(RateLimitError);
  });

  it('keeps a plain 403 an auth error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 })));
    const err = await getFile('tok', 'me/repo', 'x.json').catch((e) => e);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(err.message).toBe('GitHub API error: 403');
  });

  it('reports a create that finds the file already there (422 without a sha) as a CONFLICT, so callers re-read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }), { status: 422 })));
    await expect(putFile('tok', 'me/repo', 'x.json', '[]')).rejects.toThrow('CONFLICT');
  });
});

describe('clock skew from the commit a write creates', () => {
  // api.github.com does not expose its Date header to browsers (it is not in
  // Access-Control-Expose-Headers), so the skew check never fired in the app.
  afterEach(() => { vi.unstubAllGlobals(); __resetClockSkewForTests(); });

  it('reads the server time from the committer date of a PUT', async () => {
    const serverTime = new Date(Date.now() - 3 * 3_600_000).toISOString();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ content: { sha: 's' }, commit: { committer: { date: serverTime } } }), { status: 200 },
    )));
    await putFile('tok', 'me/repo', 'x.json', '[]', 'old');
    expect(getClockSkewMs()).toBeGreaterThan(2.9 * 3_600_000);
  });
});
