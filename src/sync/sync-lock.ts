/**
 * One sync at a time across the WHOLE app, not just this tab — see syncNow in
 * sync-engine. Its own module so code that sync-engine itself depends on (the
 * vault's at-rest migrations) can take the lock without an import cycle.
 */
export const SYNC_LOCK_NAME = 'gtd25-sync';

/**
 * Run `fn` holding the sync lock: it waits for a sync in flight in any tab, and a
 * sync that starts meanwhile skips (syncNow asks with ifAvailable). Without Web
 * Locks it just runs `fn`.
 */
export async function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request(SYNC_LOCK_NAME, fn) : fn();
}
