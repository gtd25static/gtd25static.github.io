import { vi, type Mock } from 'vitest';
import {
  getRef, createRef, updateRef, getCommit, getTree, createTree, createCommit, createBlobBase64,
  getBinaryFile, putBinaryFile, getDefaultBranch,
} from '../../sync/github-api';

function resp(status: number, body?: unknown, arrayBuffer?: ArrayBuffer) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    arrayBuffer: async () => arrayBuffer ?? new ArrayBuffer(0),
  } as unknown as Response;
}

let fetchMock: Mock;
beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); });

function lastCall() {
  const [url, opts] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: url as string, opts: opts as RequestInit, body: opts?.body ? JSON.parse(opts.body as string) : undefined };
}

describe('Git Data API helpers', () => {
  it('getRef returns the head sha, or null on 404', async () => {
    fetchMock.mockResolvedValueOnce(resp(200, { object: { sha: 'abc123' } }));
    expect(await getRef('pat', 'u/r', 'gtd25-blobs')).toBe('abc123');
    expect(lastCall().url).toContain('/git/ref/heads/gtd25-blobs');

    fetchMock.mockResolvedValueOnce(resp(404, {}));
    expect(await getRef('pat', 'u/r', 'missing')).toBeNull();
  });

  it('createTree posts the entries verbatim and returns the new tree sha', async () => {
    fetchMock.mockResolvedValueOnce(resp(201, { sha: 'tree1' }));
    const entries = [{ path: 'gtd25-shared/x', mode: '100644', type: 'blob' as const, sha: 'b1' }];
    expect(await createTree('pat', 'u/r', entries)).toBe('tree1');
    const { url, opts, body } = lastCall();
    expect(url).toContain('/git/trees');
    expect(opts.method).toBe('POST');
    expect(body.tree).toEqual(entries);
  });

  it('createCommit posts an orphan commit (no parents)', async () => {
    fetchMock.mockResolvedValueOnce(resp(201, { sha: 'commit1' }));
    expect(await createCommit('pat', 'u/r', { message: 'm', tree: 'tree1', parents: [] })).toBe('commit1');
    const { body } = lastCall();
    expect(body.parents).toEqual([]);
    expect(body.tree).toBe('tree1');
  });

  it('updateRef force-updates the ref', async () => {
    fetchMock.mockResolvedValueOnce(resp(200, {}));
    await updateRef('pat', 'u/r', 'gtd25-blobs', 'commit1', true);
    const { url, opts, body } = lastCall();
    expect(url).toContain('/git/refs/heads/gtd25-blobs');
    expect(opts.method).toBe('PATCH');
    expect(body).toEqual({ sha: 'commit1', force: true });
  });

  it('createRef / createBlobBase64 / getCommit / getTree hit the right endpoints', async () => {
    fetchMock.mockResolvedValueOnce(resp(201, {}));
    await createRef('pat', 'u/r', 'gtd25-blobs', 'c1');
    expect(lastCall().body).toEqual({ ref: 'refs/heads/gtd25-blobs', sha: 'c1' });

    fetchMock.mockResolvedValueOnce(resp(201, { sha: 'blob1' }));
    expect(await createBlobBase64('pat', 'u/r', btoa('x'))).toBe('blob1');
    expect(lastCall().body.encoding).toBe('base64');

    fetchMock.mockResolvedValueOnce(resp(200, { tree: { sha: 'treeX' }, parents: [{ sha: 'p1' }] }));
    expect(await getCommit('pat', 'u/r', 'c1')).toEqual({ treeSha: 'treeX', parents: ['p1'] });

    fetchMock.mockResolvedValueOnce(resp(200, { tree: [{ path: 'p', sha: 's', type: 'blob', mode: '100644' }], truncated: false }));
    const { entries, truncated } = await getTree('pat', 'u/r', 'treeX', true);
    expect(truncated).toBe(false);
    expect(entries).toHaveLength(1);
    expect(lastCall().url).toContain('?recursive=1');
  });
});

describe('branch-scoped binary Contents helpers', () => {
  it('getBinaryFile appends ?ref= for the branch', async () => {
    fetchMock.mockResolvedValueOnce(resp(200, undefined, new Uint8Array([1, 2, 3]).buffer));
    const out = await getBinaryFile('pat', 'u/r', 'gtd25-shared/abc', undefined, 'gtd25-blobs');
    expect(Array.from(out!)).toEqual([1, 2, 3]);
    expect(lastCall().url).toContain('/contents/gtd25-shared/abc?ref=gtd25-blobs');
  });

  it('putBinaryFile includes the branch in the commit body', async () => {
    fetchMock.mockResolvedValueOnce(resp(201, { content: { sha: 'newsha' } }));
    await putBinaryFile('pat', 'u/r', 'gtd25-shared/abc', new Uint8Array([9]), undefined, undefined, 'gtd25-blobs');
    expect(lastCall().body.branch).toBe('gtd25-blobs');
  });

  it('getDefaultBranch returns the repo default branch', async () => {
    fetchMock.mockResolvedValueOnce(resp(200, { default_branch: 'main' }));
    expect(await getDefaultBranch('pat', 'u/r')).toBe('main');
    expect(lastCall().url).toBe('https://api.github.com/repos/u/r');
  });
});
