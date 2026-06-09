export class RateLimitError extends Error {
  resetAtMs: number;
  constructor(resetAtMs: number) {
    super('GitHub API rate limit exceeded');
    this.name = 'RateLimitError';
    this.resetAtMs = resetAtMs;
  }
}

// Low-level fetch against a full api.github.com URL, with auth, timeout and
// rate-limit detection. Used by both the Contents helpers and the Git Data API
// helpers (which live under /git/... rather than /contents/...).
async function apiFetch(
  pat: string,
  url: string,
  options?: RequestInit,
  signal?: AbortSignal,
  keepalive?: boolean,
) {
  // keepalive requests outlive the page — skip timeout/abort signal
  const fetchSignal = keepalive
    ? undefined
    : signal
      ? AbortSignal.any([AbortSignal.timeout(15_000), signal])
      : AbortSignal.timeout(15_000);
  const resp = await fetch(url, {
    ...options,
    cache: 'no-store',
    signal: fetchSignal,
    keepalive,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  // Detect rate limiting on 403
  if (resp.status === 403) {
    const remaining = resp.headers.get('X-RateLimit-Remaining');
    const resetHeader = resp.headers.get('X-RateLimit-Reset');
    if (remaining === '0' && resetHeader) {
      const resetAtMs = parseInt(resetHeader, 10) * 1000;
      throw new RateLimitError(resetAtMs);
    }
  }

  return resp;
}

async function githubFetch(
  pat: string,
  repo: string,
  path: string,
  options?: RequestInit,
  signal?: AbortSignal,
  keepalive?: boolean,
) {
  return apiFetch(pat, `https://api.github.com/repos/${repo}/contents/${path}`, options, signal, keepalive);
}

function utf8ToBase64(str: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(str), (b) => String.fromCharCode(b)).join(''),
  );
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Chunked base64 of raw bytes — avoids the call-stack/string-length limits that
// String.fromCharCode(...bytes) or a per-byte loop hit on multi-MB blobs.
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function testConnection(pat: string, repo: string): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.v3+json' },
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function getFile(
  pat: string,
  repo: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ data: string; sha: string } | null> {
  const resp = await githubFetch(pat, repo, path, undefined, signal);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);

  const json = await resp.json();

  // Validate response shape — GitHub may return HTML error pages or malformed JSON
  if (!json || typeof json.content !== 'string' || typeof json.sha !== 'string') {
    throw new Error(`Malformed GitHub response for ${path}: missing content or sha`);
  }

  let data: string;
  try {
    data = base64ToUtf8(json.content);
  } catch (err) {
    throw new Error(`Failed to decode base64 content for ${path}: ${err instanceof Error ? err.message : err}`);
  }
  return { data, sha: json.sha };
}

// Conditional GET for cheap polling: pass the previous ETag as `If-None-Match`.
// A 304 ("unchanged") does NOT count against the GitHub rate limit, so the lock
// screen can poll the mailbox tightly. Distinct from getFile() so existing
// callers and their return shape are untouched.
export type ConditionalFile =
  | { status: 'unchanged'; etag: string }
  | { status: 'ok'; data: string; sha: string; etag: string | null }
  | { status: 'absent' };

export async function getFileConditional(
  pat: string,
  repo: string,
  path: string,
  etag?: string | null,
  signal?: AbortSignal,
): Promise<ConditionalFile> {
  const options = etag ? { headers: { 'If-None-Match': etag } } : undefined;
  const resp = await githubFetch(pat, repo, path, options, signal);
  if (resp.status === 304) return { status: 'unchanged', etag: etag as string };
  if (resp.status === 404) return { status: 'absent' };
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);

  const newEtag = resp.headers.get('ETag');
  const json = await resp.json();
  if (!json || typeof json.content !== 'string' || typeof json.sha !== 'string') {
    throw new Error(`Malformed GitHub response for ${path}: missing content or sha`);
  }
  let data: string;
  try {
    data = base64ToUtf8(json.content);
  } catch (err) {
    throw new Error(`Failed to decode base64 content for ${path}: ${err instanceof Error ? err.message : err}`);
  }
  return { status: 'ok', data, sha: json.sha, etag: newEtag };
}

export async function putFile(
  pat: string,
  repo: string,
  path: string,
  content: string,
  sha?: string,
  signal?: AbortSignal,
  options?: { keepalive?: boolean },
): Promise<string> {
  const body: Record<string, string> = {
    message: `gtd25 sync: ${path}`,
    content: utf8ToBase64(content),
  };
  if (sha) body.sha = sha;

  const resp = await githubFetch(pat, repo, path, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, signal, options?.keepalive);

  if (resp.status === 409) throw new Error('CONFLICT');
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);

  const json = await resp.json();
  return json.content.sha;
}

export async function deleteFile(
  pat: string,
  repo: string,
  path: string,
  sha: string,
  signal?: AbortSignal,
  branch?: string,
): Promise<void> {
  const body: Record<string, string> = { message: `gtd25: remove ${path}`, sha };
  if (branch) body.branch = branch;
  const resp = await githubFetch(pat, repo, path, {
    method: 'DELETE',
    body: JSON.stringify(body),
  }, signal);
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`GitHub API error deleting ${path}: ${resp.status}`);
  }
}

// --- Binary blobs (Shared Folder) ---
// The text helpers above assume UTF-8 and the Contents API JSON `content` field,
// which is empty for files >1 MB. These handle raw bytes and large files:
// upload via base64 in the Contents PUT (auto-commits), download via the raw
// media type (returns full content regardless of the 1 MB JSON limit).

export async function putBinaryFile(
  pat: string,
  repo: string,
  path: string,
  bytes: Uint8Array,
  sha?: string,
  signal?: AbortSignal,
  branch?: string,
): Promise<string> {
  const body: Record<string, string> = {
    message: `gtd25 sync: ${path}`,
    content: bytesToBase64(bytes),
  };
  if (sha) body.sha = sha;
  if (branch) body.branch = branch;

  const resp = await githubFetch(pat, repo, path, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, signal);

  if (resp.status === 409) throw new Error('CONFLICT');
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);

  const json = await resp.json();
  return json.content.sha;
}

export async function getBinaryFile(
  pat: string,
  repo: string,
  path: string,
  signal?: AbortSignal,
  ref?: string,
): Promise<Uint8Array | null> {
  const resp = await githubFetch(
    pat,
    repo,
    ref ? `${path}?ref=${encodeURIComponent(ref)}` : path,
    { headers: { Accept: 'application/vnd.github.raw' } },
    signal,
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// Fetch just the blob SHA (needed to delete a >1 MB file when we don't hold it).
export async function getFileSha(
  pat: string,
  repo: string,
  path: string,
  signal?: AbortSignal,
  ref?: string,
): Promise<string | null> {
  const resp = await githubFetch(pat, repo, ref ? `${path}?ref=${encodeURIComponent(ref)}` : path, undefined, signal);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  const json = await resp.json();
  if (!json || typeof json.sha !== 'string') {
    throw new Error(`Malformed GitHub response for ${path}: missing sha`);
  }
  return json.sha;
}

// --- Git Data API (branch/tree/commit plumbing for blob history compaction) ---
// These hit /repos/{repo}/git/... rather than /contents/..., so they bypass
// githubFetch and use apiFetch directly.

const gitUrl = (repo: string, sub: string) => `https://api.github.com/repos/${repo}/${sub}`;

export interface GitTreeEntry {
  path: string;
  mode: string;     // e.g. '100644'
  type: 'blob' | 'tree' | 'commit';
  sha: string | null;
}

/** Resolve a branch to its head commit SHA, or null if the branch doesn't exist. */
export async function getRef(pat: string, repo: string, branch: string, signal?: AbortSignal): Promise<string | null> {
  const resp = await apiFetch(pat, gitUrl(repo, `git/ref/heads/${encodeURIComponent(branch)}`), undefined, signal);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub API error (getRef ${branch}): ${resp.status}`);
  const json = await resp.json();
  return json?.object?.sha ?? null;
}

export async function createRef(pat: string, repo: string, branch: string, sha: string, signal?: AbortSignal): Promise<void> {
  const resp = await apiFetch(pat, gitUrl(repo, 'git/refs'), {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  }, signal);
  if (!resp.ok) throw new Error(`GitHub API error (createRef ${branch}): ${resp.status}`);
}

export async function updateRef(pat: string, repo: string, branch: string, sha: string, force: boolean, signal?: AbortSignal): Promise<void> {
  const resp = await apiFetch(pat, gitUrl(repo, `git/refs/heads/${encodeURIComponent(branch)}`), {
    method: 'PATCH',
    body: JSON.stringify({ sha, force }),
  }, signal);
  if (!resp.ok) throw new Error(`GitHub API error (updateRef ${branch}): ${resp.status}`);
}

export async function getCommit(pat: string, repo: string, sha: string, signal?: AbortSignal): Promise<{ treeSha: string; parents: string[] }> {
  const resp = await apiFetch(pat, gitUrl(repo, `git/commits/${sha}`), undefined, signal);
  if (!resp.ok) throw new Error(`GitHub API error (getCommit): ${resp.status}`);
  const json = await resp.json();
  if (!json?.tree?.sha) throw new Error('Malformed commit response: missing tree');
  const parents = Array.isArray(json.parents) ? json.parents.map((p: { sha: string }) => p.sha) : [];
  return { treeSha: json.tree.sha, parents };
}

/** The repo's default branch name (e.g. 'main' / 'master'). */
export async function getDefaultBranch(pat: string, repo: string, signal?: AbortSignal): Promise<string> {
  const resp = await apiFetch(pat, `https://api.github.com/repos/${repo}`, undefined, signal);
  if (!resp.ok) throw new Error(`GitHub API error (getDefaultBranch): ${resp.status}`);
  const json = await resp.json();
  if (typeof json?.default_branch !== 'string') throw new Error('Malformed repo response: missing default_branch');
  return json.default_branch;
}

export async function getTree(pat: string, repo: string, treeSha: string, recursive: boolean, signal?: AbortSignal): Promise<{ entries: GitTreeEntry[]; truncated: boolean }> {
  const resp = await apiFetch(pat, gitUrl(repo, `git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`), undefined, signal);
  if (!resp.ok) throw new Error(`GitHub API error (getTree): ${resp.status}`);
  const json = await resp.json();
  return { entries: (json?.tree ?? []) as GitTreeEntry[], truncated: !!json?.truncated };
}

export async function createTree(pat: string, repo: string, entries: GitTreeEntry[], signal?: AbortSignal): Promise<string> {
  const resp = await apiFetch(pat, gitUrl(repo, 'git/trees'), {
    method: 'POST',
    body: JSON.stringify({ tree: entries }),
  }, signal);
  if (!resp.ok) throw new Error(`GitHub API error (createTree): ${resp.status}`);
  const json = await resp.json();
  if (!json?.sha) throw new Error('Malformed createTree response: missing sha');
  return json.sha;
}

export async function createCommit(
  pat: string,
  repo: string,
  params: { message: string; tree: string; parents: string[] },
  signal?: AbortSignal,
): Promise<string> {
  const resp = await apiFetch(pat, gitUrl(repo, 'git/commits'), {
    method: 'POST',
    body: JSON.stringify(params),
  }, signal);
  if (!resp.ok) throw new Error(`GitHub API error (createCommit): ${resp.status}`);
  const json = await resp.json();
  if (!json?.sha) throw new Error('Malformed createCommit response: missing sha');
  return json.sha;
}

export async function createBlobBase64(pat: string, repo: string, base64: string, signal?: AbortSignal): Promise<string> {
  const resp = await apiFetch(pat, gitUrl(repo, 'git/blobs'), {
    method: 'POST',
    body: JSON.stringify({ content: base64, encoding: 'base64' }),
  }, signal);
  if (!resp.ok) throw new Error(`GitHub API error (createBlob): ${resp.status}`);
  const json = await resp.json();
  if (!json?.sha) throw new Error('Malformed createBlob response: missing sha');
  return json.sha;
}

// Legacy compat exports
export const getFileContent = (pat: string, repo: string) =>
  getFile(pat, repo, 'gtd25-data.json');

export const putFileContent = (pat: string, repo: string, content: string, sha?: string) =>
  putFile(pat, repo, 'gtd25-data.json', content, sha);
