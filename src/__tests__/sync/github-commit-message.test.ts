import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Paranoid Mode neutralizes the app-identifying commit message on the wire.
let paranoid = false;
vi.mock('../../db/paranoid-flag', () => ({
  isParanoidFlagSet: () => paranoid,
  PARANOID_FLAG: 'gtd25-paranoid',
}));

import { putFile, deleteFile, putBinaryFile, createCommit } from '../../sync/github-api';

function resp(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  paranoid = false;
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); });

function lastBody(): Record<string, unknown> {
  const [, opts] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return JSON.parse((opts as RequestInit).body as string);
}

describe('commit-message neutralization', () => {
  it('putFile keeps the branded message when NOT paranoid', async () => {
    fetchMock.mockResolvedValueOnce(resp(200, { content: { sha: 's' } }));
    await putFile('pat', 'u/r', 'gtd25-snapshot.json', '{}');
    expect(lastBody().message).toBe('gtd25 sync: gtd25-snapshot.json');
  });

  it('putFile strips the brand to a generic message when paranoid', async () => {
    paranoid = true;
    fetchMock.mockResolvedValueOnce(resp(200, { content: { sha: 's' } }));
    await putFile('pat', 'u/r', 'gtd25-snapshot.json', '{}');
    const msg = lastBody().message as string;
    expect(msg).toBe('update');
    expect(msg).not.toContain('gtd25');
  });

  it('deleteFile neutralizes the message when paranoid', async () => {
    paranoid = true;
    fetchMock.mockResolvedValueOnce(resp(200, {}));
    await deleteFile('pat', 'u/r', 'gtd25-changelog.json', 'sha1');
    expect(lastBody().message).toBe('update');
  });

  it('putBinaryFile neutralizes the message when paranoid', async () => {
    paranoid = true;
    fetchMock.mockResolvedValueOnce(resp(201, { content: { sha: 's' } }));
    await putBinaryFile('pat', 'u/r', 'gtd25-shared/x', new Uint8Array([1]));
    expect(lastBody().message).toBe('update');
  });

  it('createCommit (Git Data API) neutralizes the message when paranoid', async () => {
    paranoid = true;
    fetchMock.mockResolvedValueOnce(resp(201, { sha: 'c1' }));
    await createCommit('pat', 'u/r', { message: 'gtd25: compact history', tree: 't', parents: [] });
    expect(lastBody().message).toBe('update');
  });

  it('createCommit keeps the original message when NOT paranoid', async () => {
    fetchMock.mockResolvedValueOnce(resp(201, { sha: 'c1' }));
    await createCommit('pat', 'u/r', { message: 'gtd25: compact history', tree: 't', parents: [] });
    expect(lastBody().message).toBe('gtd25: compact history');
  });
});
