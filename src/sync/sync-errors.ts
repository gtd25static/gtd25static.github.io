// Typed classification of sync failures, produced where the engine still has the
// real error (HTTP status, rate-limit headers, version gate) so the UI never has
// to string-match error messages. Display-only: nothing here is synced or stored.

import { RateLimitError } from './github-api';

export type SyncErrorCategory =
  | 'rate-limited'
  | 'auth'
  | 'repo-missing'
  | 'update-required'
  | 'conflict'
  | 'wrong-password'
  | 'corrupt-remote'
  | 'server'
  | 'timeout'
  | 'network'
  | 'unknown';

export interface SyncErrorInfo {
  category: SyncErrorCategory;
  /** Raw error detail, for tooltips/diagnostics. */
  message: string;
  /** When the rate-limit window resets (epoch ms). */
  retryAtMs?: number;
}

// github-api error messages all end in `: ${resp.status}` (with optional
// parenthetical context in between), so the status is the message suffix.
function httpStatusOf(message: string): number {
  return parseInt(message.match(/(\d{3})\s*$/)?.[1] ?? '', 10);
}

export function classifySyncError(err: unknown): SyncErrorInfo {
  const message = err instanceof Error ? err.message : String(err ?? 'Sync failed');
  if (err instanceof RateLimitError) {
    return { category: 'rate-limited', message, retryAtMs: err.resetAtMs };
  }
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { category: 'timeout', message };
  }
  // AES-GCM decrypt failure surfaces as a DOMException OperationError
  if (err instanceof DOMException && err.name === 'OperationError') {
    return { category: 'wrong-password', message };
  }
  if (message === 'CONFLICT') {
    return { category: 'conflict', message };
  }
  if (message.startsWith('GitHub API error')) {
    const status = httpStatusOf(message);
    if (status === 401 || status === 403) return { category: 'auth', message };
    if (status === 404) return { category: 'repo-missing', message };
    if (status >= 500) return { category: 'server', message };
    return { category: 'unknown', message };
  }
  if (message.startsWith('Malformed GitHub response') || message.startsWith('Failed to decode base64')) {
    return { category: 'corrupt-remote', message };
  }
  if (err instanceof TypeError || /network|fetch|offline/i.test(message)) {
    return { category: 'network', message };
  }
  if (/decrypt/i.test(message)) {
    return { category: 'wrong-password', message };
  }
  return { category: 'unknown', message };
}

function formatClockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Short, actionable label for the sync indicator. */
export function syncErrorLabel(info: SyncErrorInfo): string {
  switch (info.category) {
    case 'rate-limited':
      return info.retryAtMs ? `Rate limited — resumes ${formatClockTime(info.retryAtMs)}` : 'Rate limited — will retry';
    case 'auth':
      return 'Token rejected — check PAT in Settings';
    case 'repo-missing':
      // A 404 can also be a valid PAT without access to the repo
      return 'Repo not found — check Settings → Sync';
    case 'update-required':
      return 'Update required — reload app';
    case 'conflict':
      return 'Conflict — will retry';
    case 'wrong-password':
      return 'Wrong password';
    case 'corrupt-remote':
      return 'Remote data corrupted';
    case 'server':
      return 'GitHub unavailable — retrying';
    case 'timeout':
      return 'Timeout — will retry';
    case 'network':
      return 'No connection';
    case 'unknown':
      return 'Sync error';
  }
}
