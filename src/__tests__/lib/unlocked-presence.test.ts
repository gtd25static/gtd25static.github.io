import { holdUnlockedPresence, anyTabUnlocked } from '../../lib/unlocked-presence';

// A same-origin Web Locks stand-in: shared locks held until their callback's
// promise settles, and a query that lists them.
function fakeLocks() {
  const held: Array<{ name: string; mode: string }> = [];
  return {
    held,
    request: vi.fn((name: string, opts: { mode: string }, cb: () => Promise<void>) => {
      const entry = { name, mode: opts.mode };
      held.push(entry);
      return cb().finally(() => held.splice(held.indexOf(entry), 1));
    }),
    query: vi.fn(async () => ({ held: [...held], pending: [] })),
  };
}

describe('unlocked presence (Web Locks)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a tab holds a shared lock while unlocked, and releases it', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    expect(await anyTabUnlocked()).toBe(false);

    const release = holdUnlockedPresence();
    expect(locks.request).toHaveBeenCalledWith('gtd25-unlocked', { mode: 'shared' }, expect.any(Function));
    expect(await anyTabUnlocked()).toBe(true);

    release();
    await vi.waitFor(async () => expect(await anyTabUnlocked()).toBe(false));
  });

  it('another tab\'s lock counts, held or waiting', async () => {
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [], pending: [{ name: 'gtd25-unlocked', mode: 'shared' }] }) } });
    expect(await anyTabUnlocked()).toBe(true);
  });

  it('unrelated locks do not', async () => {
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [{ name: 'gtd25-sync', mode: 'exclusive' }], pending: [] }) } });
    expect(await anyTabUnlocked()).toBe(false);
  });

  // Can't tell is not "nobody": the caller must not reload other tabs on a guess.
  it('null without Web Locks, or when the query fails', async () => {
    vi.stubGlobal('navigator', {});
    expect(await anyTabUnlocked()).toBeNull();
    expect(() => holdUnlockedPresence()()).not.toThrow();
    vi.stubGlobal('navigator', { locks: { query: async () => { throw new Error('SecurityError'); } } });
    expect(await anyTabUnlocked()).toBeNull();
  });
});
