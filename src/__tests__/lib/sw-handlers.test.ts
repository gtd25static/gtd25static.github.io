// Unit tests for the service-worker handlers (extracted into src/lib/sw-handlers.ts
// precisely so they can be tested — sw.ts itself is a vite-plugin-pwa entry).
// Node env: Request/Response/File/FormData are real (undici); two SW-runtime gaps
// are shimmed below (relative URLs, Response.redirect).
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  SHARE_CACHE, SHARE_META_PATH, shareFilePath, MAX_SHARE_FILES,
  type SharedPayloadMeta,
} from '../../lib/share-target';
import {
  handleShareTarget, isShareTargetPost, redactUrlForLog,
  handleNotificationClick, handleSwMessage,
} from '../../lib/sw-handlers';

const SW_ORIGIN = 'https://sw.test';
const NativeRequest = Request;

// In a real SW, relative URLs resolve against the worker's location; undici has no
// base URL and throws. Resolve them against a fixed test origin instead.
class SwScopedRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, SW_ORIGIN) : input, init);
  }
}

interface RecordingCache {
  puts: { path: string; response: Response }[];
}

// Recording CacheStorage fake: captures every put (by pathname) and delete.
function installFakeCaches(opts: { failPutAt?: number; failDelete?: boolean } = {}) {
  const cache: RecordingCache = { puts: [] };
  const deletes: string[] = [];
  let putCount = 0;
  (globalThis as unknown as { caches: unknown }).caches = {
    open: async () => ({
      put: async (req: Request, response: Response) => {
        putCount++;
        if (opts.failPutAt !== undefined && putCount === opts.failPutAt) throw new Error('quota');
        cache.puts.push({ path: new URL(req.url).pathname, response });
      },
    }),
    delete: async (name: string) => {
      if (opts.failDelete) throw new Error('cache gone');
      deletes.push(name);
      return true;
    },
  };
  return { cache, deletes };
}

function shareRequest(fields: Record<string, string>, files: File[] = []): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append('files', f);
  return new NativeRequest(`${SW_ORIGIN}/share-target`, { method: 'POST', body: form });
}

beforeEach(() => {
  vi.stubGlobal('Request', SwScopedRequest);
  // undici's Response.redirect rejects relative URLs; capture them instead.
  vi.spyOn(Response, 'redirect').mockImplementation(
    (url: string | URL, status?: number) =>
      new Response(null, { status: status ?? 302, headers: { Location: String(url) } }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

async function metaFrom(cache: RecordingCache): Promise<SharedPayloadMeta> {
  const put = cache.puts.find((p) => p.path === SHARE_META_PATH);
  expect(put).toBeDefined();
  return (await put!.response.json()) as SharedPayloadMeta;
}

describe('handleShareTarget', () => {
  it('stashes meta + files and redirects into the app', async () => {
    const { cache } = installFakeCaches();
    const files = [
      new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }),
      new File([new Uint8Array([4, 5])], 'doc.pdf', { type: 'application/pdf' }),
    ];
    const res = await handleShareTarget(shareRequest({ title: 'T', text: 'hello', url: 'https://x.test/a' }, files));

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/?shareTarget=1');
    const meta = await metaFrom(cache);
    expect(meta).toMatchObject({
      title: 'T', text: 'hello', url: 'https://x.test/a', skippedFiles: 0,
      files: [
        { name: 'photo.png', type: 'image/png', size: 3 },
        { name: 'doc.pdf', type: 'application/pdf', size: 2 },
      ],
    });
    expect(meta.ts).toBeGreaterThan(0);
    const filePuts = cache.puts.filter((p) => p.path !== SHARE_META_PATH);
    expect(filePuts.map((p) => p.path)).toEqual([shareFilePath(0), shareFilePath(1)]);
    expect(filePuts[0].response.headers.get('Content-Type')).toBe('image/png');
    expect((await filePuts[0].response.arrayBuffer()).byteLength).toBe(3);
  });

  it('applies the ACR-018 caps and records skipped files in the meta', async () => {
    const { cache } = installFakeCaches();
    const files = Array.from({ length: MAX_SHARE_FILES + 5 }, (_, i) =>
      new File([new Uint8Array([i])], `f${i}.bin`, { type: 'application/octet-stream' }));
    const res = await handleShareTarget(shareRequest({}, files));

    expect(res.headers.get('Location')).toBe('/?shareTarget=1');
    const meta = await metaFrom(cache);
    expect(meta.files).toHaveLength(MAX_SHARE_FILES);
    expect(meta.skippedFiles).toBe(5);
    expect(cache.puts.filter((p) => p.path !== SHARE_META_PATH)).toHaveLength(MAX_SHARE_FILES);
  });

  it('defaults missing fields and nameless/typeless files', async () => {
    const { cache } = installFakeCaches();
    // A multipart round-trip drops a filename="" part, so hand the handler a
    // pre-built FormData directly to exercise its name/type fallbacks.
    const form = new FormData();
    form.append('files', new File([new Uint8Array([9])], ''));
    const res = await handleShareTarget({ formData: async () => form } as unknown as Request);

    expect(res.headers.get('Location')).toBe('/?shareTarget=1');
    const meta = await metaFrom(cache);
    expect(meta).toMatchObject({ title: '', text: '', url: '' });
    expect(meta.files[0]).toEqual({ name: 'shared-0', type: 'application/octet-stream', size: 1 });
    const filePut = cache.puts.find((p) => p.path === shareFilePath(0));
    expect(filePut!.response.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('ignores non-File entries under the files key', async () => {
    const { cache } = installFakeCaches();
    const form = new FormData();
    form.append('files', 'not-a-file');
    const res = await handleShareTarget(new NativeRequest(`${SW_ORIGIN}/share-target`, { method: 'POST', body: form }));

    expect(res.headers.get('Location')).toBe('/?shareTarget=1');
    const meta = await metaFrom(cache);
    expect(meta.files).toEqual([]);
    expect(meta.skippedFiles).toBe(0);
  });

  it('drops a partial stash and redirects to the error flag when a put fails (ACR-017)', async () => {
    // Fail the SECOND put (a file body) so the meta put has already succeeded.
    const { deletes } = installFakeCaches({ failPutAt: 2 });
    const res = await handleShareTarget(shareRequest({ title: 'T' }, [new File([new Uint8Array([1])], 'a.bin')]));

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/?shareTarget=error');
    expect(deletes).toContain(SHARE_CACHE);
  });

  it('redirects to the error flag when the body is not parseable form data', async () => {
    const { deletes } = installFakeCaches();
    const res = await handleShareTarget(new NativeRequest(`${SW_ORIGIN}/share-target`, { method: 'POST', body: 'plain text' }));

    expect(res.headers.get('Location')).toBe('/?shareTarget=error');
    expect(deletes).toContain(SHARE_CACHE);
  });

  it('still returns the error redirect when even the cleanup delete throws', async () => {
    installFakeCaches({ failPutAt: 1, failDelete: true });
    const res = await handleShareTarget(shareRequest({ title: 'T' }));

    expect(res.headers.get('Location')).toBe('/?shareTarget=error');
  });
});

describe('isShareTargetPost', () => {
  it('matches only POST requests to the share-target action', () => {
    expect(isShareTargetPost(new NativeRequest(`${SW_ORIGIN}/share-target`, { method: 'POST', body: 'x' }))).toBe(true);
    expect(isShareTargetPost(new NativeRequest(`${SW_ORIGIN}/share-target`))).toBe(false); // GET
    expect(isShareTargetPost(new NativeRequest(`${SW_ORIGIN}/other`, { method: 'POST', body: 'x' }))).toBe(false);
    expect(isShareTargetPost(new NativeRequest(`${SW_ORIGIN}/share-target?x=1`, { method: 'POST', body: 'x' }))).toBe(true);
  });
});

describe('redactUrlForLog (ACR-004)', () => {
  it('strips the query string and keeps origin + path', () => {
    expect(redactUrlForLog('https://app.test/capture?title=secret&text=hidden')).toBe('https://app.test/capture');
  });

  it('caps the output at 100 chars', () => {
    const long = `https://app.test/${'a'.repeat(200)}`;
    expect(redactUrlForLog(long)).toHaveLength(100);
  });

  it('never throws on junk', () => {
    expect(redactUrlForLog('not a url')).toBe('[unparseable url]');
  });
});

describe('handleNotificationClick', () => {
  function makeHost(
    clients: { url: string; focus?: () => Promise<unknown> }[],
    openWindow?: (url: string) => Promise<unknown>,
  ) {
    return {
      location: { origin: SW_ORIGIN },
      clients: { matchAll: async () => clients, openWindow },
    };
  }

  it('focuses an existing same-origin window instead of opening a new one', async () => {
    const focus = vi.fn().mockResolvedValue(undefined);
    const openWindow = vi.fn();
    await handleNotificationClick(makeHost([{ url: `${SW_ORIGIN}/`, focus }], openWindow));

    expect(focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('ignores foreign-origin clients and opens a window', async () => {
    const focus = vi.fn();
    const openWindow = vi.fn().mockResolvedValue(undefined);
    await handleNotificationClick(makeHost([{ url: 'https://elsewhere.test/', focus }], openWindow));

    expect(focus).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith(`${SW_ORIGIN}/`);
  });

  it('falls through to openWindow when the matched client cannot focus', async () => {
    const openWindow = vi.fn().mockResolvedValue(undefined);
    await handleNotificationClick(makeHost([{ url: `${SW_ORIGIN}/` }], openWindow));

    expect(openWindow).toHaveBeenCalledWith(`${SW_ORIGIN}/`);
  });

  it('resolves the notification data url against the SW origin', async () => {
    const openWindow = vi.fn().mockResolvedValue(undefined);
    await handleNotificationClick(makeHost([], openWindow), { url: '/?view=focus' });

    expect(openWindow).toHaveBeenCalledWith(`${SW_ORIGIN}/?view=focus`);
  });

  it('does nothing (and does not throw) when openWindow is unavailable', async () => {
    await expect(handleNotificationClick(makeHost([]))).resolves.toBeUndefined();
  });
});

describe('handleSwMessage', () => {
  it('runs skipWaiting for SKIP_WAITING and hands back its promise', async () => {
    const skipWaiting = vi.fn().mockResolvedValue(undefined);
    const pending = handleSwMessage({ type: 'SKIP_WAITING' }, { skipWaiting });

    expect(skipWaiting).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBeUndefined();
  });

  it('ignores anything else', () => {
    const skipWaiting = vi.fn();
    expect(handleSwMessage({ type: 'OTHER' }, { skipWaiting })).toBeNull();
    expect(handleSwMessage(null, { skipWaiting })).toBeNull();
    expect(handleSwMessage('SKIP_WAITING', { skipWaiting })).toBeNull();
    expect(skipWaiting).not.toHaveBeenCalled();
  });
});
