// Panic wipe: erase every local trace of the app from this device.
//
// Used both as the Paranoid Mode "forgot passphrase" escape hatch (the vault is
// unrecoverable, so the only move is to start clean) and as a deliberate
// settings action. Data synced to other devices / GitHub is untouched — this is
// purely local. The steps are independent and best-effort: one failing (e.g. no
// CacheStorage in this browser) must not stop the rest, so each is guarded.
//
// Reliability: IndexedDB deletion can be BLOCKED by another tab holding the DB
// open, in which case it may never complete. A wipe-pending marker is set
// before the steps run and cleared only once the deletion is confirmed; on the
// next boot retryPendingWipe() finishes an interrupted wipe before the app
// opens the database again.

import { db } from '../db';
import { lock } from '../db/vault';

// Deliberately survives clearWebStorage (see skip below): it is the retry
// breadcrumb for a wipe whose IndexedDB deletion could not be confirmed.
export const WIPE_PENDING_KEY = 'gtd25-wipe-pending';

async function deleteIndexedDb(): Promise<'deleted' | 'incomplete'> {
  try {
    db.close();
  } catch { /* already closed */ }
  return await new Promise<'deleted' | 'incomplete'>((resolve) => {
    let settled = false;
    const done = (outcome: 'deleted' | 'incomplete') => {
      if (!settled) { settled = true; resolve(outcome); }
    };
    try {
      const req = indexedDB.deleteDatabase('gtd25');
      req.onsuccess = () => done('deleted');
      req.onerror = () => done('incomplete');
      // Open connections elsewhere — don't hang the wipe; the marker keeps it
      // retryable. (The browser may still complete the delete once they close.)
      req.onblocked = () => done('incomplete');
    } catch {
      done('incomplete');
    }
  });
}

function clearWebStorage(): void {
  try {
    // Snapshot keys via the index API (works across browsers) before mutating,
    // since removing shifts indices.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null) keys.push(k);
    }
    for (const key of keys) {
      if (key === WIPE_PENDING_KEY) continue; // cleared only after confirmed deletion
      if (key.startsWith('gtd25-')) localStorage.removeItem(key);
    }
  } catch { /* ignore */ }
  try {
    sessionStorage.clear();
  } catch { /* ignore */ }
}

async function clearCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* ignore */ }
}

async function unregisterServiceWorkers(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch { /* ignore */ }
}

/**
 * Wipe all local app data. Drops the in-memory DEK first (so nothing can be
 * decrypted mid-wipe), then deletes IndexedDB, gtd25 localStorage + all
 * sessionStorage, the Workbox caches, and the service worker. The wipe-pending
 * marker is cleared only when the IndexedDB deletion is confirmed — otherwise
 * it stays armed for retryPendingWipe() on the next boot. By default it
 * reloads the page afterward to land on a pristine app; pass `{ reload: false }`
 * (e.g. in tests) to skip that.
 */
export async function panicWipe(opts: { reload?: boolean } = {}): Promise<void> {
  const { reload = true } = opts;

  try { lock(); } catch { /* vault may not be active */ }
  try { localStorage.setItem(WIPE_PENDING_KEY, String(Date.now())); } catch { /* no storage — proceed */ }

  const idbOutcome = await deleteIndexedDb();
  clearWebStorage();
  await clearCaches();
  await unregisterServiceWorkers();

  if (idbOutcome === 'deleted') {
    try { localStorage.removeItem(WIPE_PENDING_KEY); } catch { /* ignore */ }
  }

  if (reload && typeof window !== 'undefined') {
    try { window.location.reload(); } catch { /* environment without a real location */ }
  }
}

/**
 * Boot-time retry of an interrupted wipe (call before the app opens the DB).
 * Re-runs the wipe steps without reloading — if the deletion is still blocked
 * the marker stays armed for the next boot and the app continues; the steps
 * are idempotent on an already-clean profile.
 */
export async function retryPendingWipe(): Promise<void> {
  let pending = false;
  try { pending = localStorage.getItem(WIPE_PENDING_KEY) != null; } catch { /* no storage */ }
  if (!pending) return;
  await panicWipe({ reload: false });
}
