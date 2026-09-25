import { getFile, RateLimitError } from '../../sync/github-api';

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
