// An in-memory GitHub repository behind the surface of sync/github-api: files on
// branches, with sha-based optimistic concurrency, plus the git objects the
// compaction and rotation code drive directly (refs, commits, trees, blobs).
// A test installs it with
//   vi.mock('../../sync/github-api', async () => (await import('../helpers/fake-repo')).fakeGitHubApi);
// and reads or seeds it through `fakeRepo`.

import type { GitTreeEntry } from '../../sync/github-api';

type Obj =
  | { kind: 'blob'; bytes: Uint8Array }
  | { kind: 'tree'; entries: GitTreeEntry[] }
  | { kind: 'commit'; tree: string; parents: string[]; message: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_BRANCH = 'main';

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class FakeRepo {
  objects = new Map<string, Obj>();
  refs = new Map<string, string>();
  private counter = 0;

  reset(): void {
    this.objects.clear();
    this.refs.clear();
    this.counter = 0;
  }

  private put(obj: Obj): string {
    const sha = `${obj.kind}-${++this.counter}`;
    this.objects.set(sha, obj);
    return sha;
  }

  private headTree(branch: string): Map<string, string> {
    const head = this.refs.get(branch);
    if (!head) return new Map();
    const commit = this.objects.get(head);
    if (commit?.kind !== 'commit') throw new Error(`fake repo: ${head} is not a commit`);
    const tree = this.objects.get(commit.tree);
    if (tree?.kind !== 'tree') throw new Error(`fake repo: ${commit.tree} is not a tree`);
    return new Map(tree.entries.filter((e) => e.sha).map((e) => [e.path, e.sha!]));
  }

  private commitTree(branch: string, files: Map<string, string>, message: string): void {
    const entries: GitTreeEntry[] = [...files].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha }));
    const tree = this.put({ kind: 'tree', entries });
    const head = this.refs.get(branch);
    this.refs.set(branch, this.put({ kind: 'commit', tree, parents: head ? [head] : [], message }));
  }

  /** How many commits the branch's history holds. */
  historyLength(branch = DEFAULT_BRANCH): number {
    let sha = this.refs.get(branch);
    let n = 0;
    while (sha) {
      const commit = this.objects.get(sha);
      if (commit?.kind !== 'commit') break;
      n++;
      sha = commit.parents[0];
    }
    return n;
  }

  readBytes(path: string, branch = DEFAULT_BRANCH): Uint8Array | null {
    const sha = this.headTree(branch).get(path);
    if (!sha) return null;
    const blob = this.objects.get(sha);
    return blob?.kind === 'blob' ? blob.bytes : null;
  }

  readText(path: string, branch = DEFAULT_BRANCH): string | null {
    const bytes = this.readBytes(path, branch);
    return bytes ? decoder.decode(bytes) : null;
  }

  sha(path: string, branch = DEFAULT_BRANCH): string | null {
    return this.headTree(branch).get(path) ?? null;
  }

  writeBytes(path: string, bytes: Uint8Array, branch = DEFAULT_BRANCH, expectedSha?: string): string {
    const files = this.headTree(branch);
    const current = files.get(path);
    if (current && expectedSha !== undefined && expectedSha !== current) throw new Error('CONFLICT');
    const sha = this.put({ kind: 'blob', bytes });
    files.set(path, sha);
    this.commitTree(branch, files, `put ${path}`);
    return sha;
  }

  writeText(path: string, text: string, branch = DEFAULT_BRANCH, expectedSha?: string): string {
    return this.writeBytes(path, encoder.encode(text), branch, expectedSha);
  }

  remove(path: string, branch = DEFAULT_BRANCH, expectedSha?: string): void {
    const files = this.headTree(branch);
    const current = files.get(path);
    if (!current) return;
    if (expectedSha !== undefined && expectedSha !== current) throw new Error('CONFLICT');
    files.delete(path);
    this.commitTree(branch, files, `remove ${path}`);
  }

  listPaths(branch = DEFAULT_BRANCH): string[] {
    return [...this.headTree(branch).keys()].sort();
  }

  // --- the github-api surface ---

  readonly api = {
    RateLimitError: class RateLimitError extends Error {
      resetAtMs?: number;
      constructor(resetAtMs?: number) { super('rate limited'); this.name = 'RateLimitError'; this.resetAtMs = resetAtMs; }
    },
    testConnection: async () => true,
    getFile: async (_pat: string, _repo: string, path: string) => {
      const sha = this.sha(path);
      return sha ? { data: this.readText(path)!, sha } : null;
    },
    getFileConditional: async () => { throw new Error('fake repo: getFileConditional not modelled'); },
    putFile: async (_pat: string, _repo: string, path: string, content: string, sha?: string) =>
      this.writeText(path, content, DEFAULT_BRANCH, sha),
    deleteFile: async (_pat: string, _repo: string, path: string, sha: string, _signal?: AbortSignal, branch?: string) =>
      this.remove(path, branch ?? DEFAULT_BRANCH, sha),
    putBinaryFile: async (_pat: string, _repo: string, path: string, bytes: Uint8Array, sha?: string, _signal?: AbortSignal, branch?: string) =>
      this.writeBytes(path, bytes, branch ?? DEFAULT_BRANCH, sha),
    getBinaryFile: async (_pat: string, _repo: string, path: string, _signal?: AbortSignal, ref?: string) =>
      this.readBytes(path, ref ?? DEFAULT_BRANCH),
    getFileSha: async (_pat: string, _repo: string, path: string, _signal?: AbortSignal, ref?: string) =>
      this.sha(path, ref ?? DEFAULT_BRANCH),
    getRef: async (_pat: string, _repo: string, branch: string) => this.refs.get(branch) ?? null,
    createRef: async (_pat: string, _repo: string, branch: string, sha: string) => {
      if (this.refs.has(branch)) throw new Error('GitHub API error (createRef): 422');
      this.refs.set(branch, sha);
    },
    updateRef: async (_pat: string, _repo: string, branch: string, sha: string, force: boolean) => {
      if (!force && this.refs.has(branch)) throw new Error('fake repo: non-fast-forward update needs force');
      this.refs.set(branch, sha);
    },
    getCommit: async (_pat: string, _repo: string, sha: string) => {
      const commit = this.objects.get(sha);
      if (commit?.kind !== 'commit') throw new Error('GitHub API error (getCommit): 404');
      return { treeSha: commit.tree, parents: commit.parents };
    },
    getDefaultBranch: async () => DEFAULT_BRANCH,
    getTree: async (_pat: string, _repo: string, treeSha: string) => {
      const tree = this.objects.get(treeSha);
      if (tree?.kind !== 'tree') throw new Error('GitHub API error (getTree): 404');
      return { entries: tree.entries, truncated: false };
    },
    createTree: async (_pat: string, _repo: string, entries: GitTreeEntry[]) =>
      this.put({ kind: 'tree', entries: entries.filter((e) => e.sha) }),
    createCommit: async (_pat: string, _repo: string, params: { message: string; tree: string; parents: string[] }) =>
      this.put({ kind: 'commit', tree: params.tree, parents: params.parents, message: params.message }),
    createBlobBase64: async (_pat: string, _repo: string, base64: string) =>
      this.put({ kind: 'blob', bytes: bytesFromBase64(base64) }),
    getFileContent: async () => null,
    putFileContent: async () => { throw new Error('fake repo: legacy put not modelled'); },
  };
}

export const fakeRepo = new FakeRepo();
export const fakeGitHubApi = fakeRepo.api;
