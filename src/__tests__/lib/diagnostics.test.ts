import { vi } from 'vitest';
import {
  recordError, getErrorLog, clearErrorLog, subscribeErrors,
  detectFeatures, requestPersistentStorage, isStoragePersisted, getBuildInfo,
} from '../../lib/diagnostics';
import { handleDbError } from '../../lib/db-error';

interface NavWithStorage { storage?: { persist?: () => Promise<boolean>; persisted?: () => Promise<boolean> } }
let savedStorage: PropertyDescriptor | undefined;

beforeEach(() => { clearErrorLog(); });
afterEach(() => {
  vi.restoreAllMocks();
  if (savedStorage) { Object.defineProperty(navigator, 'storage', savedStorage); savedStorage = undefined; }
});

describe('diagnostics: error log', () => {
  it('records errors and notifies subscribers', () => {
    const cb = vi.fn();
    const unsub = subscribeErrors(cb);
    recordError('ctx', new Error('boom'));
    expect(getErrorLog()).toHaveLength(1);
    expect(getErrorLog()[0]).toMatchObject({ context: 'ctx', message: 'boom' });
    expect(cb).toHaveBeenCalled();
    unsub();
  });

  it('accepts non-Error values and never throws', () => {
    expect(() => recordError('ctx', 'just a string')).not.toThrow();
    expect(() => recordError('ctx', { weird: true })).not.toThrow();
    expect(getErrorLog().length).toBe(2);
  });

  it('never serializes an arbitrary object payload into the log (no content leak)', () => {
    // A stray throw/rejection could carry an entity-shaped object; its fields must not
    // end up in the user-readable diagnostics log.
    recordError('ctx', { taskTitle: 'Buy the secret gift', notes: 'meet at 5pm' });
    const msg = getErrorLog()[0].message;
    expect(msg).not.toContain('secret gift');
    expect(msg).not.toContain('meet at 5pm');
    expect(msg).toBe('[Object]');
  });

  it('truncates an over-long error message', () => {
    // Use a realistic message with whitespace (a single 5000-char run would be redacted
    // as a high-entropy blob by the ACR-015 secret scrubber, not truncated).
    recordError('ctx', new Error('word '.repeat(1000)));
    const msg = getErrorLog()[0].message;
    expect(msg.length).toBeLessThan(5000);
    expect(msg).toContain('+');
    expect(msg).toContain('chars]');
  });

  it('redacts secrets from recorded messages (ACR-015)', () => {
    recordError('ctx', new Error('failed with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 oops'));
    recordError('ctx', new Error('GET /capture?title=MySecretNote&text=private&url=https://x.com failed'));
    recordError('ctx', new Error('Authorization: Bearer sk_live_abcdef1234567890ABCDEF dropped'));
    const log = getErrorLog();
    const all = log.map((e) => e.message).join('\n');
    expect(all).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(all).not.toContain('MySecretNote');
    expect(all).not.toContain('private');
    expect(all).toContain('[redacted');
  });

  it('caps the ring buffer at 100 entries', () => {
    for (let i = 0; i < 150; i++) recordError('ctx', new Error(`e${i}`));
    expect(getErrorLog()).toHaveLength(100);
    // Oldest dropped: the last entry is the newest.
    expect(getErrorLog()[99].message).toBe('e149');
  });

  it('clear empties the log', () => {
    recordError('ctx', new Error('x'));
    clearErrorLog();
    expect(getErrorLog()).toHaveLength(0);
  });

  it('captures handled database errors shown as toasts', () => {
    const err = new Error('transaction closed');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    handleDbError(err, 'update task');

    expect(getErrorLog()).toHaveLength(1);
    expect(getErrorLog()[0]).toMatchObject({
      context: 'db.update task',
      message: 'transaction closed',
    });
    spy.mockRestore();
  });
});

describe('diagnostics: feature detection & build', () => {
  it('reports the capabilities sync/paranoid depend on', () => {
    const f = detectFeatures();
    expect(typeof f.cryptoSubtle).toBe('boolean');
    expect(f.indexedDB).toBe(true);          // fake-indexeddb is installed
    expect(typeof f.webAuthn).toBe('boolean');
    expect(typeof f.idleDetector).toBe('boolean');
  });

  it('exposes build info', () => {
    const b = getBuildInfo();
    expect(typeof b.version).toBe('string');
    expect(typeof b.commit).toBe('string');
  });
});

describe('diagnostics: persistent storage', () => {
  function mockStorage(impl: NavWithStorage['storage']) {
    savedStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'storage', { configurable: true, value: impl });
  }

  it('returns false when the Storage API is unavailable', async () => {
    mockStorage(undefined);
    expect(await requestPersistentStorage()).toBe(false);
    expect(await isStoragePersisted()).toBe('unknown');
  });

  it('short-circuits when already persisted', async () => {
    const persist = vi.fn();
    mockStorage({ persist, persisted: () => Promise.resolve(true) });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('requests persistence when not yet persisted', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    mockStorage({ persist, persisted: () => Promise.resolve(false) });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalled();
  });
});
