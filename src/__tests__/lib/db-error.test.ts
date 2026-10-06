import { vi } from 'vitest';
import Dexie from 'dexie';

vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../lib/diagnostics', () => ({ recordError: vi.fn() }));

// Reliability review 2026-10-06 (B13): Dexie hands storage-full back as its own
// QuotaExceededError (not a DOMException), and Chrome often as an AbortError
// carrying the quota error inside — so "Storage full" was never said, and the
// user was told to try again.

// The setup file already loaded the real modules: load them again under the mocks.
async function load() {
  vi.resetModules();
  const { handleDbError, isQuotaError } = await import('../../lib/db-error');
  const { toast } = await import('../../components/ui/Toast');
  return { handleDbError, isQuotaError, toast: vi.mocked(toast) };
}

describe('storage full is recognised', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['a DOMException', () => new DOMException('full', 'QuotaExceededError')],
    ['Dexie\'s own error', () => new Dexie.QuotaExceededError('full')],
    ['an abort carrying it', () => new Dexie.AbortError('aborted', new DOMException('full', 'QuotaExceededError'))],
  ])('as %s', async (_label, make) => {
    const { handleDbError, isQuotaError, toast } = await load();
    expect(isQuotaError(make())).toBe(true);
    handleDbError(make(), 'save task');
    expect(toast.mock.calls[0][0]).toMatch(/Storage full/);
  });

  it('and nothing else is', async () => {
    const { isQuotaError } = await load();
    expect(isQuotaError(new Error('boom'))).toBe(false);
    expect(isQuotaError(new Dexie.AbortError('aborted'))).toBe(false);
  });
});
