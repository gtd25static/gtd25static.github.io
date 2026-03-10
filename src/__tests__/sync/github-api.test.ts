import { RateLimitError } from '../../sync/github-api';

describe('RateLimitError', () => {
  it('has correct properties', () => {
    const resetAt = Date.now() + 60_000;
    const err = new RateLimitError(resetAt);
    expect(err.name).toBe('RateLimitError');
    expect(err.resetAtMs).toBe(resetAt);
    expect(err.message).toBe('GitHub API rate limit exceeded');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof RateLimitError).toBe(true);
  });
});
