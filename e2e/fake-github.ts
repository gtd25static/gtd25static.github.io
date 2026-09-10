// In-memory stand-in for the slice of the GitHub REST API the app uses
// (src/sync/github-api.ts), installed per browser context with context.route().
// It also blocks every request to any other external host, so a test can never
// leak to the internet, and records what it blocked for the fixture to fail on.
import { createHash } from 'node:crypto';
import type { BrowserContext, Route } from '@playwright/test';

export interface RecordedRequest {
  method: string;
  /** Path + query, e.g. /repos/o/r/contents/gtd25-snapshot.json */
  path: string;
  /** Node-side Date.now() when the request was intercepted. */
  time: number;
  status: number;
}

interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

const DEFAULT_BRANCH = 'main';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// The headers real api.github.com sends on every response, so CORS and the
// app's ETag reads behave as they do in production.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers':
    'ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, ' +
    'X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, ' +
    'X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, Deprecation, Sunset',
};

/** Git's blob id, so SHAs look and behave like GitHub's (content-addressed). */
function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): FakeResponse {
  return { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(value) };
}

export class FakeGitHub {
  readonly requests: RecordedRequest[] = [];
  /** Routes the fake does not implement (answered 404). */
  readonly unhandled: string[] = [];
  /** Requests to external hosts other than api.github.com (aborted). */
  readonly blockedExternal: string[] = [];
  /** Requests currently stalled by hold(). */
  held = 0;
  /** `${branch}:${path}` -> file bytes + blob sha. */
  private readonly files = new Map<string, { bytes: Buffer; sha: string }>();
  private holdGate: Promise<void> | null = null;

  constructor(
    readonly token = 'ghp_e2eFakeTokenForTheLocalFakeGitHubOnly00',
    readonly owner = 'e2e-owner',
    readonly repo = 'e2e-sync-repo',
  ) {}

  get fullName(): string {
    return `${this.owner}/${this.repo}`;
  }

  /** Route api.github.com to this fake and block every other external host. */
  async install(context: BrowserContext): Promise<void> {
    await context.route(
      (url) => /^(https?|wss?):$/.test(url.protocol) && !LOCAL_HOSTS.has(url.hostname) && url.hostname !== 'api.github.com',
      (route) => {
        this.blockedExternal.push(`${route.request().method()} ${route.request().url()}`);
        return route.abort('blockedbyclient');
      },
    );
    await context.route('https://api.github.com/**', (route) => this.handle(route));
  }

  /** Stall every GitHub response — a slow network — until the returned release() is called. */
  hold(): () => void {
    let release!: () => void;
    this.holdGate = new Promise<void>((resolve) => { release = resolve; });
    return () => {
      this.holdGate = null;
      release();
    };
  }

  hasFile(path: string, branch = DEFAULT_BRANCH): boolean {
    return this.files.has(`${branch}:${path}`);
  }

  readText(path: string, branch = DEFAULT_BRANCH): string | undefined {
    return this.files.get(`${branch}:${path}`)?.bytes.toString('utf8');
  }

  /** Every stored file as `branch:path` -> base64 bytes, for byte-identical comparisons. */
  repoContents(): Record<string, string> {
    return Object.fromEntries([...this.files].map(([key, file]) => [key, file.bytes.toString('base64')]));
  }

  requestsSince(time: number): RecordedRequest[] {
    return this.requests.filter((r) => r.time >= time);
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    if (method === 'OPTIONS') {
      // CORS preflight (Playwright usually answers these itself; not recorded).
      await route.fulfill({
        status: 204,
        headers: {
          ...CORS_HEADERS,
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE',
          'Access-Control-Allow-Headers': 'Authorization, Accept, Content-Type, If-None-Match',
          'Access-Control-Max-Age': '86400',
        },
      });
      return;
    }
    if (this.holdGate) {
      this.held++;
      try { await this.holdGate; } finally { this.held--; }
    }
    const headers = await request.allHeaders();
    const response = this.respond(method, url, headers, request.postData());
    this.requests.push({ method, path: url.pathname + url.search, time: Date.now(), status: response.status });
    try {
      await route.fulfill({
        status: response.status,
        headers: { ...CORS_HEADERS, Date: new Date().toUTCString(), 'X-RateLimit-Remaining': '4999', ...response.headers },
        body: response.body,
      });
    } catch {
      // The page gave up on the request while it was held (e.g. its sync was aborted).
    }
  }

  private respond(method: string, url: URL, headers: Record<string, string>, postData: string | null): FakeResponse {
    if (headers.authorization !== `Bearer ${this.token}`) return json(401, { message: 'Bad credentials' });

    const repoPrefix = `/repos/${this.owner}/${this.repo}`;
    if (url.pathname === repoPrefix && method === 'GET') {
      return json(200, { full_name: this.fullName, private: true, default_branch: DEFAULT_BRANCH });
    }
    const contentsPrefix = `${repoPrefix}/contents/`;
    if (!url.pathname.startsWith(contentsPrefix)) return this.unhandledRoute(method, url);

    const path = decodeURIComponent(url.pathname.slice(contentsPrefix.length));
    const name = path.slice(path.lastIndexOf('/') + 1);

    if (method === 'GET') {
      const file = this.files.get(`${url.searchParams.get('ref') ?? DEFAULT_BRANCH}:${path}`);
      if (!file) return json(404, { message: 'Not Found' });
      const etag = `"${file.sha}"`;
      if (headers['if-none-match']?.replace(/^W\//, '') === etag) return { status: 304, headers: { ETag: etag } };
      if (headers.accept?.includes('application/vnd.github.raw')) {
        return { status: 200, headers: { ETag: etag, 'Content-Type': 'application/vnd.github.raw' }, body: file.bytes };
      }
      return json(200, {
        type: 'file', encoding: 'base64', name, path, size: file.bytes.length, sha: file.sha,
        content: file.bytes.toString('base64'),
      }, { ETag: etag });
    }

    if (method === 'PUT' || method === 'DELETE') {
      let body: { content?: unknown; sha?: unknown; branch?: unknown };
      try {
        body = JSON.parse(postData ?? '{}');
      } catch {
        return json(400, { message: 'Problems parsing JSON' });
      }
      const key = `${typeof body.branch === 'string' ? body.branch : DEFAULT_BRANCH}:${path}`;
      const existing = this.files.get(key);

      if (method === 'DELETE') {
        if (!existing) return json(404, { message: 'Not Found' });
        if (body.sha !== existing.sha) return json(409, { message: `${path} does not match ${String(body.sha)}` });
        this.files.delete(key);
        return json(200, { content: null, commit: { sha: gitBlobSha(Buffer.from(`delete ${key} ${Date.now()}`)) } });
      }

      if (typeof body.content !== 'string') return json(422, { message: 'Invalid request: content is required' });
      // Optimistic concurrency exactly as the app relies on: the caller must name the
      // sha it is replacing, and must not name one when creating.
      if ((existing?.sha ?? undefined) !== (body.sha ?? undefined)) {
        return json(409, { message: `${path} does not match ${String(body.sha ?? '')}` });
      }
      const bytes = Buffer.from(body.content, 'base64');
      const sha = gitBlobSha(bytes);
      this.files.set(key, { bytes, sha });
      return json(existing ? 200 : 201, {
        content: { name, path, sha, size: bytes.length },
        commit: { sha: gitBlobSha(Buffer.from(`commit ${key} ${sha} ${Date.now()}`)) },
      });
    }

    return this.unhandledRoute(method, url);
  }

  private unhandledRoute(method: string, url: URL): FakeResponse {
    const entry = `${method} ${url.pathname}${url.search}`;
    this.unhandled.push(entry);
    console.warn(`[fake-github] unhandled route (answered 404): ${entry}`);
    return json(404, { message: 'Not Found' });
  }
}
