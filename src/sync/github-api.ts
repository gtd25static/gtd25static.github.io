interface GitHubFileResponse {
  content: string;
  sha: string;
}

async function githubFetch(
  pat: string,
  repo: string,
  path: string,
  options?: RequestInit,
  signal?: AbortSignal,
) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const timeoutSignal = AbortSignal.timeout(15_000);
  const signals = signal
    ? AbortSignal.any([timeoutSignal, signal])
    : timeoutSignal;
  const resp = await fetch(url, {
    ...options,
    cache: 'no-store',
    signal: signals,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
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

  const json: GitHubFileResponse = await resp.json();
  const data = base64ToUtf8(json.content);
  return { data, sha: json.sha };
}

export async function putFile(
  pat: string,
  repo: string,
  path: string,
  content: string,
  sha?: string,
  signal?: AbortSignal,
): Promise<string> {
  const body: Record<string, string> = {
    message: `gtd25 sync: ${path}`,
    content: utf8ToBase64(content),
  };
  if (sha) body.sha = sha;

  const resp = await githubFetch(pat, repo, path, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, signal);

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
