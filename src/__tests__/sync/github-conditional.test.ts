import { describe, it, expect, vi, afterEach } from 'vitest';
import { getFileConditional } from '../../sync/github-api';

const PAT = 'tok';
const REPO = 'me/repo';

function b64(s: string): string {
  return btoa(Array.from(new TextEncoder().encode(s), (c) => String.fromCharCode(c)).join(''));
}

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => Promise.resolve(impl(url, init))));
}

afterEach(() => vi.unstubAllGlobals());

describe('getFileConditional', () => {
  it('sends If-None-Match when an etag is supplied and returns "unchanged" on 304', async () => {
    let seen: Record<string, string> | undefined;
    mockFetch((_url, init) => {
      seen = init.headers as Record<string, string>;
      return new Response(null, { status: 304 });
    });

    const res = await getFileConditional(PAT, REPO, 'gtd25-cmd-x.json', 'W/"abc"');
    expect(seen?.['If-None-Match']).toBe('W/"abc"');
    expect(res).toEqual({ status: 'unchanged', etag: 'W/"abc"' });
  });

  it('returns content + new etag on 200 and omits If-None-Match when no etag given', async () => {
    let seen: Record<string, string> | undefined;
    mockFetch((_url, init) => {
      seen = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ content: b64('{"hello":1}'), sha: 'sha1' }), {
        status: 200,
        headers: { ETag: 'W/"new"' },
      });
    });

    const res = await getFileConditional(PAT, REPO, 'gtd25-cmd-x.json');
    expect(seen?.['If-None-Match']).toBeUndefined();
    expect(res).toEqual({ status: 'ok', data: '{"hello":1}', sha: 'sha1', etag: 'W/"new"' });
  });

  it('returns "absent" on 404', async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    expect(await getFileConditional(PAT, REPO, 'gtd25-cmd-x.json', 'W/"abc"')).toEqual({ status: 'absent' });
  });

  it('throws on other errors', async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    await expect(getFileConditional(PAT, REPO, 'gtd25-cmd-x.json')).rejects.toThrow(/GitHub API error: 500/);
  });
});
