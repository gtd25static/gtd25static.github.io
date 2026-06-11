import { describe, it, expect } from 'vitest';
import { RateLimitError } from '../../sync/github-api';
import { classifySyncError, syncErrorLabel, type SyncErrorInfo } from '../../sync/sync-errors';

describe('classifySyncError', () => {
  it('classifies RateLimitError with the reset time', () => {
    const resetAt = Date.now() + 120_000;
    const info = classifySyncError(new RateLimitError(resetAt));
    expect(info.category).toBe('rate-limited');
    expect(info.retryAtMs).toBe(resetAt);
  });

  it('classifies fetch timeouts and aborts', () => {
    expect(classifySyncError(new DOMException('timed out', 'TimeoutError')).category).toBe('timeout');
    expect(classifySyncError(new DOMException('aborted', 'AbortError')).category).toBe('timeout');
  });

  it('classifies AES-GCM decrypt failures as wrong password', () => {
    expect(classifySyncError(new DOMException('', 'OperationError')).category).toBe('wrong-password');
    expect(classifySyncError(new Error('Failed to decrypt entry')).category).toBe('wrong-password');
  });

  it('classifies the optimistic-concurrency conflict marker', () => {
    expect(classifySyncError(new Error('CONFLICT')).category).toBe('conflict');
  });

  it('classifies GitHub HTTP statuses, including parenthetical variants', () => {
    expect(classifySyncError(new Error('GitHub API error: 401')).category).toBe('auth');
    expect(classifySyncError(new Error('GitHub API error: 403')).category).toBe('auth');
    expect(classifySyncError(new Error('GitHub API error: 404')).category).toBe('repo-missing');
    expect(classifySyncError(new Error('GitHub API error: 502')).category).toBe('server');
    expect(classifySyncError(new Error('GitHub API error (getRef main): 404')).category).toBe('repo-missing');
    expect(classifySyncError(new Error('GitHub API error deleting gtd25-snapshot.json: 500')).category).toBe('server');
    expect(classifySyncError(new Error('GitHub API error: 422')).category).toBe('unknown');
  });

  it('does NOT treat a "5" in a filename as a server error (old includes("5") bug)', () => {
    const info = classifySyncError(new Error('Malformed GitHub response for gtd25-snapshot.json: missing content or sha'));
    expect(info.category).toBe('corrupt-remote');
    expect(classifySyncError(new Error('Failed to decode base64 content for gtd25-changelog.json: bad')).category).toBe('corrupt-remote');
  });

  it('classifies network failures', () => {
    expect(classifySyncError(new TypeError('Failed to fetch')).category).toBe('network');
    expect(classifySyncError(new Error('network unreachable')).category).toBe('network');
  });

  it('falls back to unknown and keeps the raw message', () => {
    const info = classifySyncError(new Error('something odd'));
    expect(info.category).toBe('unknown');
    expect(info.message).toBe('something odd');
    expect(classifySyncError(undefined).category).toBe('unknown');
    expect(classifySyncError('plain string').message).toBe('plain string');
  });
});

describe('syncErrorLabel', () => {
  const label = (category: SyncErrorInfo['category'], retryAtMs?: number) =>
    syncErrorLabel({ category, message: 'x', retryAtMs });

  it('formats the rate-limit resume time as HH:MM', () => {
    const at = new Date('2026-06-11T14:32:00').getTime();
    expect(label('rate-limited', at)).toBe('Rate limited — resumes 14:32');
    expect(label('rate-limited')).toBe('Rate limited — will retry');
  });

  it('produces actionable text per category', () => {
    expect(label('auth')).toBe('Token rejected — check PAT in Settings');
    expect(label('repo-missing')).toBe('Repo not found — check Settings → Sync');
    expect(label('update-required')).toBe('Update required — reload app');
    expect(label('conflict')).toBe('Conflict — will retry');
    expect(label('wrong-password')).toBe('Wrong password');
    expect(label('corrupt-remote')).toBe('Remote data corrupted');
    expect(label('server')).toBe('GitHub unavailable — retrying');
    expect(label('timeout')).toBe('Timeout — will retry');
    expect(label('network')).toBe('No connection');
    expect(label('unknown')).toBe('Sync error');
  });
});
