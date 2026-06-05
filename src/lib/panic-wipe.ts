// Panic wipe: erase every local trace of the app from this device.
//
// Used both as the Paranoid Mode "forgot passphrase" escape hatch (the vault is
// unrecoverable, so the only move is to start clean) and as a deliberate
// settings action. Data synced to other devices / GitHub is untouched — this is
// purely local. The steps are independent and best-effort: one failing (e.g. no
// CacheStorage in this browser) must not stop the rest, so each is guarded.

import { db } from '../db';
import { lock } from '../db/vault';

async function deleteIndexedDb(): Promise<void> {
  try {
    db.close();
  } catch { /* already closed */ }
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const req = indexedDB.deleteDatabase('gtd25');
      req.onsuccess = done;
      req.onerror = done;
      req.onblocked = done; // open connections elsewhere — don't hang the wipe
    } catch {
      done();
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
 * sessionStorage, the Workbox caches, and the service worker. By default it
 * reloads the page afterward to land on a pristine app; pass `{ reload: false }`
 * (e.g. in tests) to skip that.
 */
export async function panicWipe(opts: { reload?: boolean } = {}): Promise<void> {
  const { reload = true } = opts;

  try { lock(); } catch { /* vault may not be active */ }

  await deleteIndexedDb();
  clearWebStorage();
  await clearCaches();
  await unregisterServiceWorkers();

  if (reload && typeof window !== 'undefined') {
    window.location.reload();
  }
}
