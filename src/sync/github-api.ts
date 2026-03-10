export class RateLimitError extends Error {
  resetAtMs: number;
  constructor(resetAtMs: number) {
    super('GitHub API rate limit exceeded');
    this.name = 'RateLimitError';
    this.resetAtMs = resetAtMs;
  }
}

async function githubFetch(
  pat: string,
  repo: string,
  path: string,
  options?: RequestInit,
  signal?: AbortSignal,
  keepalive?: boolean,
) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
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
): Promise<void> {
  const resp = await githubFetch(pat, repo, path, {
    method: 'DELETE',
    body: JSON.stringify({
      message: `gtd25: remove ${path}`,
      sha,
    }),
  }, signal);
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`GitHub API error deleting ${path}: ${resp.status}`);
  }
}

// Legacy compat exports
export const getFileContent = (pat: string, repo: string) =>
  getFile(pat, repo, 'gtd25-data.json');

export const putFileContent = (pat: string, repo: string, content: string, sha?: string) =>
  putFile(pat, repo, 'gtd25-data.json', content, sha);
