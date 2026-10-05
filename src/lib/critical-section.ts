// Operations that must not be cut short by a reload: replacing local data from a
// backup or the remote, a force push, a sync-password change, the vault's
// enable / disable / re-key. Applying an app update reloads EVERY tab
// (vite-plugin-pwa reloads each one on `controlling`), and one tab tapping
// "Update" used to cut another tab's import in half.
//
// Each such operation holds a SHARED Web Lock for its duration; applying an
// update takes the same lock EXCLUSIVELY, so it waits for every tab's operations
// to finish and keeps new ones from starting until the reload. While one runs,
// a beforeunload prompt also asks before the tab is closed or reloaded by hand.

const LOCK_NAME = 'gtd25-critical';

let active = 0;

function guardUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = ''; // older browsers need it set to show the prompt
}

function locks(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}

/**
 * Run `fn` as a critical section (see above). Sections may run in parallel, but
 * must NOT nest: with an update waiting for the exclusive lock, the inner
 * request would queue behind it while the outer one holds the shared lock the
 * update waits for — a deadlock. (The `*HoldingLock` variants in the sync engine
 * exist so callers already inside one do not open another.)
 */
export async function inCriticalSection<T>(fn: () => Promise<T>): Promise<T> {
  active++;
  if (active === 1 && typeof window !== 'undefined') window.addEventListener('beforeunload', guardUnload);
  try {
    const lockManager = locks();
    return lockManager ? await lockManager.request(LOCK_NAME, { mode: 'shared' }, fn) : await fn();
  } finally {
    active--;
    if (active === 0 && typeof window !== 'undefined') window.removeEventListener('beforeunload', guardUnload);
  }
}

/** True while a critical section runs in this tab. */
export function isInCriticalSection(): boolean {
  return active > 0;
}

/**
 * Run `apply` once no tab is in a critical section, and keep new ones from
 * starting until the page goes away (`apply` is expected to reload it). Without
 * Web Locks, waits for this tab's sections only.
 */
export async function whenNoCriticalSection(apply: () => void): Promise<void> {
  const lockManager = locks();
  if (lockManager) {
    // Held until the reload: an import started meanwhile in another tab would
    // otherwise run straight into it.
    void lockManager.request(LOCK_NAME, { mode: 'exclusive' }, () => {
      apply();
      return new Promise<never>(() => {});
    });
    return;
  }
  while (active > 0) await new Promise((r) => setTimeout(r, 200));
  apply();
}
