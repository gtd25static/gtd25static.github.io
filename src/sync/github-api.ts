import { isParanoidFlagSet } from '../db/paranoid-flag';
import { recordServerDate } from '../lib/clock-skew';

export class RateLimitError extends Error {
  resetAtMs: number;
  constructor(resetAtMs: number) {
    super('GitHub API rate limit exceeded');
    this.name = 'RateLimitError';
    this.resetAtMs = resetAtMs;
  }
}

// In Paranoid Mode, strip the app-identifying commit message ("gtd25 sync: …")
// so a TLS-intercepting proxy doesn't see the app branded in the request body.
// Commit messages are write-only (never read back by the app), so neutralizing
// them is purely a wire-fingerprint reduction with no functional effect. The
// URL path still carries the filename — renaming those is a separate migration.
const GENERIC_COMMIT_MESSAGE = 'update';
function commitMessage(branded: string): string {
  return isParanoidFlagSet() ? GENERIC_COMMIT_MESSAGE : branded;
}

const BASE_TIMEOUT_MS = 15_000;

/**
 * Time budget for a request moving `bytes` over the wire: 15 s, plus a second per
 * 256 KiB (a ~2 Mbit/s floor) — a shared file of tens of MB used to be aborted at
 * 15 s on slower links, and every retry sent it whole again. Below 256 KiB this
 * is the plain 15 s.
 */
export function transferTimeoutMs(bytes: number): number {
  return BASE_TIMEOUT_MS + Math.floor(bytes / 262_144) * 1000;
}

// A Contents API GET inlines files up to 1 MB as base64 (~1.4 MB of JSON); its
// size is unknown until it arrives, so it gets the budget of the largest one.
const CONTENTS_DOWNLOAD_TIMEOUT_MS = transferTimeoutMs(1_400_000);

// GitHub asks clients that hit a secondary rate limit without a Retry-After to
// wait at least a minute.
const SECONDARY_LIMIT_WAIT_MS = 60_000;

// Low-level fetch against a full api.github.com URL, with auth, timeout and
// rate-limit detection. Used by both the Contents helpers and the Git Data API
// helpers (which live under /git/... rather than /contents/...). The timeout
// scales with the request body unless the caller sets one (a download's size is
// only known to the caller).
async function apiFetch(
  pat: string,
  url: string,
  options?: RequestInit,
  signal?: AbortSignal,
  keepalive?: boolean,
  timeoutMs?: number,
) {
  const budget = timeoutMs ?? transferTimeoutMs(typeof options?.body === 'string' ? options.body.length : 0);
  // keepalive requests outlive the page — skip timeout/abort signal
  const fetchSignal = keepalive
    ? undefined
    : signal
      ? AbortSignal.any([AbortSignal.timeout(budget), signal])
      : AbortSignal.timeout(budget);
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

  // Every response carries the server's clock — free skew detection for the
  // LWW merge, which is only as trustworthy as the writing device's Date.now().
  recordServerDate(resp.headers.get('Date'));

  // Rate limits: a 403 with no requests left (primary), a 429, a 403 with
  // Retry-After, or a 403 whose message says so (secondary). A secondary limit
  // used to read as "Token rejected — check PAT", nudging the user to replace a
  // token that worked.
  if (resp.status === 403 || resp.status === 429) {
    const remaining = resp.headers.get('X-RateLimit-Remaining');
    const resetHeader = resp.headers.get('X-RateLimit-Reset');
    const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '', 10);
    if (Number.isFinite(retryAfter)) throw new RateLimitError(Date.now() + retryAfter * 1000);
    if (remaining === '0' && resetHeader) {
      const resetAtMs = parseInt(resetHeader, 10) * 1000;
      throw new RateLimitError(resetAtMs);
    }
    if (resp.status === 429) throw new RateLimitError(Date.now() + SECONDARY_LIMIT_WAIT_MS);
    const message = await resp.clone().text().catch(() => '');
    if (/rate limit/i.test(message)) throw new RateLimitError(Date.now() + SECONDARY_LIMIT_WAIT_MS);
  }

  return resp;
}

/**
 * The server's clock, from the commit a Contents write created. api.github.com
 * does not expose its Date header to browsers (it is not in
 * Access-Control-Expose-Headers), so the skew check apiFetch feeds was blind in
 * the app; the committer date of a write is set by the server.
 */
function recordCommitDate(json: unknown): void {
  const date = (json as { commit?: { committer?: { date?: unknown } } } | null)?.commit?.committer?.date;
  if (typeof date === 'string') recordServerDate(date);
}

async function githubFetch(
  pat: string,
  repo: string,
  path: string,
  options?: RequestInit,
  signal?: AbortSignal,
  keepalive?: boolean,
  timeoutMs?: number,
) {
  return apiFetch(pat, `https://api.github.com/repos/${repo}/contents/${path}`, options, signal, keepalive, timeoutMs);
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

export interface TokenReach {
  /** A classic token's scopes (X-OAuth-Scopes); null for a fine-grained token, or when unknown. */
  classicScopes: string[] | null;
  /** Whether the token can push to the repository that serves this app. */
  canPushAppSite: boolean;
}

/**
 * How far the sync token reaches beyond the sync repository. A classic token with
 * `repo` scope opens every repository of its account — on the account that hosts
 * this app, its own site too: one push there runs on every device at the next
 * update, so a PAT leaked to a TLS proxy, a keylogger or a disk image (Scenarios
 * 4, 5, 8) would become code execution everywhere. Best-effort; never throws.
 */
export async function tokenReach(pat: string): Promise<TokenReach> {
  const headers = { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.v3+json' };
  const get = (url: string) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000), headers });
  let classicScopes: string[] | null = null;
  try {
    const resp = await get('https://api.github.com/user');
    const raw = resp.headers.get('X-OAuth-Scopes');
    if (resp.ok && raw !== null) classicScopes = raw.split(',').map((scope) => scope.trim()).filter(Boolean);
  } catch { /* unknown */ }
  let canPushAppSite = false;
  const host = typeof location === 'undefined' ? '' : location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.slice(0, -'.github.io'.length);
    try {
      const resp = await get(`https://api.github.com/repos/${owner}/${host}`);
      if (resp.ok) canPushAppSite = !!((await resp.json()) as { permissions?: { push?: boolean } }).permissions?.push;
    } catch { /* unknown */ }
  }
  return { classicScopes, canPushAppSite };
}

/** What to tell the user about a token that reaches too far, or null. */
export function tokenReachWarning(reach: TokenReach): string | null {
  if (reach.canPushAppSite) {
    return 'This token can push to the repository that hosts this app: whoever obtains it could change the app on every device. Use a fine-grained token limited to your sync repository.';
  }
  if (reach.classicScopes?.some((scope) => scope === 'repo' || scope === 'public_repo' || scope === 'workflow')) {
    return 'This classic token opens all your repositories. A fine-grained token limited to the sync repository (Contents: read and write) is safer.';
  }
  return null;
}

export async function getFile(
  pat: string,
  repo: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ data: string; sha: string; etag?: string } | null> {
  const resp = await githubFetch(pat, repo, path, undefined, signal, false, CONTENTS_DOWNLOAD_TIMEOUT_MS);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  // The ETag lets a later conditional GET (the Paranoid idle probe) ask whether
  // the file changed since this read.
  const etag = resp.headers.get('ETag') ?? undefined;
  return { ...(await decodeContentsResponse(pat, repo, path, await resp.json(), signal)), etag };
}

// The snapshot and changelog are written by whoever holds the PAT, and parsed
// whole: past this a file is refused rather than downloaded and parsed until the
// tab runs out of memory (the same bound as a backup import's decoded data).
export const MAX_REMOTE_FILE_BYTES = 80 * 1024 * 1024;

// The Contents API only inlines files up to 1 MB. Above that it answers with
// `content: ""` and `encoding: "none"` — decoding that as base64 silently yields
// an empty file, which the sync engine then read as an empty/corrupt snapshot
// (~900 tasks is enough to get there). The bytes come from the git blob of the
// SAME sha, so content and sha can't drift apart between the two requests.
async function decodeContentsResponse(
  pat: string,
  repo: string,
  path: string,
  json: unknown,
  signal?: AbortSignal,
): Promise<{ data: string; sha: string }> {
  const file = json as { content?: unknown; sha?: unknown; encoding?: unknown; size?: unknown } | null;
  // Validate response shape — GitHub may return HTML error pages or malformed JSON
  if (!file || typeof file.content !== 'string' || typeof file.sha !== 'string') {
    throw new Error(`Malformed GitHub response for ${path}: missing content or sha`);
  }
  if (typeof file.size === 'number' && file.size > MAX_REMOTE_FILE_BYTES) {
    throw new Error(`${path} is too large to sync (${file.size} bytes)`);
  }
  const notInlined = file.encoding === 'none' || (file.content === '' && typeof file.size === 'number' && file.size > 0);
  if (notInlined) {
    // Sized by the file: a fixed 15 s never finished a few-MB snapshot on a slow
    // mobile link, so a device there could not sync (nor push) at all.
    const resp = await apiFetch(pat, gitUrl(repo, `git/blobs/${file.sha}`), {
      headers: { Accept: 'application/vnd.github.raw' },
    }, signal, false, transferTimeoutMs(typeof file.size === 'number' ? file.size : MAX_REMOTE_FILE_BYTES));
    if (!resp.ok) throw new Error(`GitHub API error: ${resp.status} (blob for ${path})`);
    const declared = Number(resp.headers.get('Content-Length'));
    if (declared > MAX_REMOTE_FILE_BYTES) throw new Error(`${path} is too large to sync (${declared} bytes)`);
    const bytes = await resp.arrayBuffer();
    if (bytes.byteLength > MAX_REMOTE_FILE_BYTES) throw new Error(`${path} is too large to sync (${bytes.byteLength} bytes)`);
    return { data: new TextDecoder().decode(bytes), sha: file.sha };
  }
  let data: string;
  try {
    data = base64ToUtf8(file.content);
  } catch (err) {
    throw new Error(`Failed to decode base64 content for ${path}: ${err instanceof Error ? err.message : err}`);
  }
  return { data, sha: file.sha };
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
  const { data, sha } = await decodeContentsResponse(pat, repo, path, await resp.json(), signal);
  return { status: 'ok', data, sha, etag: newEtag };
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
    message: commitMessage(`gtd25 sync: ${path}`),
    content: utf8ToBase64(content),
  };
  if (sha) body.sha = sha;

  const resp = await githubFetch(pat, repo, path, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, signal, options?.keepalive);

  if (resp.status === 409) throw new Error('CONFLICT');
  // A create (no sha) that finds the file there is a 422 — e.g. the retry of a
  // create whose reply was lost. It is the same race as a 409: re-read, retry.
  if (resp.status === 422 && !sha) throw new Error('CONFLICT');
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);

  const json = await resp.json();
  recordCommitDate(json);
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
  const body: Record<string, string> = { message: commitMessage(`gtd25: remove ${path}`), sha };
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
    message: commitMessage(`gtd25 sync: ${path}`),
    content: bytesToBase64(bytes),
  };
  if (sha) body.sha = sha;
  if (branch) body.branch = branch;

  const resp = await githubFetch(pat, repo, path, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, signal);

  if (resp.status === 409) throw new Error('CONFLICT');
  if (resp.status === 422 && !sha) throw new Error('CONFLICT');
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);

  const json = await resp.json();
  recordCommitDate(json);
  return json.content.sha;
}

export async function getBinaryFile(
  pat: string,
  repo: string,
  path: string,
  signal?: AbortSignal,
  ref?: string,
  timeoutMs?: number,
): Promise<Uint8Array | null> {
  const resp = await githubFetch(
    pat,
    repo,
    ref ? `${path}?ref=${encodeURIComponent(ref)}` : path,
    { headers: { Accept: 'application/vnd.github.raw' } },
    signal,
    false,
    timeoutMs,
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
    body: JSON.stringify({ ...params, message: commitMessage(params.message) }),
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

