// The share stash holds shared content in PLAINTEXT in Cache Storage until the
// app consumes it. Its 24h bound (ACR-017) used to be enforced only by the sweep
// in use-share-target, which mounts UNLOCKED — so a Paranoid device left locked
// kept the bytes indefinitely, and after 24h the lock screen stopped even saying
// they were there. The purge needs no vault key, so it runs while locked too.
import {
  purgeExpiredShareStash, hasFreshShareStash, SHARE_STASH_TTL_MS,
  SHARE_CACHE, SHARE_META_PATH as META,
} from '../../lib/share-target';

function fakeCaches(meta: unknown | null) {
  // Bodies are single-use, and the real Cache Storage hands out a FRESH Response
  // per match — store the bytes and rebuild, or the second reader sees nothing.
  const store = new Map<string, string>();
  if (meta !== null) store.set(META, JSON.stringify(meta));
  const deleted: string[] = [];
  const cache = {
    match: async (path: string) => {
      const body = store.get(path);
      return body === undefined ? undefined : new Response(body);
    },
  };
  vi.stubGlobal('caches', {
    has: async (name: string) => name === SHARE_CACHE && !deleted.includes(name),
    open: async () => cache,
    delete: async (name: string) => { deleted.push(name); store.clear(); return true; },
  });
  return { deleted };
}

afterEach(() => vi.unstubAllGlobals());

describe('purgeExpiredShareStash', () => {
  it('deletes a stash past its TTL', async () => {
    const { deleted } = fakeCaches({ ts: Date.now() - SHARE_STASH_TTL_MS - 1, files: [] });

    expect(await purgeExpiredShareStash()).toBe(true);
    expect(deleted).toContain(SHARE_CACHE);
  });

  it('leaves a fresh stash alone — it is still waiting to be consumed', async () => {
    const { deleted } = fakeCaches({ ts: Date.now(), files: [] });

    expect(await purgeExpiredShareStash()).toBe(false);
    expect(deleted).toEqual([]);
    expect(await hasFreshShareStash()).toBe(true);
  });

  it('drops a partial stash with no metadata at all', async () => {
    const { deleted } = fakeCaches(null);

    expect(await purgeExpiredShareStash()).toBe(true);
    expect(deleted).toContain(SHARE_CACHE);
  });

  it('is a no-op on a device that never received a share', async () => {
    vi.stubGlobal('caches', { has: async () => false, open: async () => { throw new Error('must not open'); } });

    expect(await purgeExpiredShareStash()).toBe(false);
  });
});
