// Each tab with its vault open (or with Paranoid Mode off) holds a shared Web Lock
// for as long as it stays that way, so a locked tab can tell, before it applies
// an update on its own — the reload hits every tab — whether one of them would
// lose an open vault and whatever was being typed in it. The tab channel can't
// say so: it carries only signals that reduce access (lib/tab-channel). Presence
// only: the lock carries nothing, and holding it opens nothing.

const LOCK_NAME = 'gtd25-unlocked';

function webLocks(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}

/** Hold the presence lock; the function returned lets it go. */
export function holdUnlockedPresence(): () => void {
  const locks = webLocks();
  if (!locks?.request) return () => {};
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  void locks.request(LOCK_NAME, { mode: 'shared' }, () => held).catch(() => {});
  return () => release();
}

/**
 * Whether some tab holds (or is about to hold) the presence lock. Null when this
 * browser can't tell — no Web Locks, or the query failed — which a caller must
 * not read as "nobody".
 */
export async function anyTabUnlocked(): Promise<boolean | null> {
  const locks = webLocks();
  if (!locks?.query) return null;
  try {
    const { held = [], pending = [] } = await locks.query();
    return [...held, ...pending].some((lock) => lock.name === LOCK_NAME);
  } catch {
    return null;
  }
}
