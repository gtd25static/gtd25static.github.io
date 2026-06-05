// Diagnostics & reliability helpers.
//
// Goals:
//  - Capture errors (including ones that would otherwise vanish) into a small
//    in-memory ring buffer the user can read/copy from Settings, so an obscure
//    failure can be reported and fixed even when devtools aren't handy.
//  - Report which browser capabilities the app depends on, so a breakage caused
//    by the browser ecosystem (a removed/blocked API) is immediately visible.
//  - Ask the browser to PERSIST storage, so IndexedDB isn't silently evicted
//    under pressure (data-loss prevention).

import { APP_VERSION, GIT_COMMIT } from './constants';

export interface LoggedError {
  at: number;
  context: string;
  message: string;
  stack?: string;
}

const MAX_ERRORS = 100;
const errorLog: LoggedError[] = [];
const listeners = new Set<() => void>();

/** Record an error against a context label. Never throws. */
export function recordError(context: string, err: unknown): void {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
    errorLog.push({ at: Date.now(), context, message: e.message || String(err), stack: e.stack });
    if (errorLog.length > MAX_ERRORS) errorLog.shift();
    for (const l of listeners) l();
  } catch { /* diagnostics must never make things worse */ }
}

export function getErrorLog(): readonly LoggedError[] {
  return errorLog;
}

export function clearErrorLog(): void {
  errorLog.length = 0;
  for (const l of listeners) l();
}

export function subscribeErrors(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

let handlersInstalled = false;
/** Capture uncaught errors and unhandled promise rejections into the log. */
export function installGlobalErrorHandlers(): void {
  if (handlersInstalled || typeof window === 'undefined') return;
  handlersInstalled = true;
  window.addEventListener('error', (e) => recordError('window.error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => recordError('unhandledrejection', e.reason));
}

export interface FeatureReport {
  secureContext: boolean;
  cryptoSubtle: boolean;
  indexedDB: boolean;
  webAuthn: boolean;
  webAuthnPrfPossible: boolean; // platform authenticator present (PRF not guaranteed)
  idleDetector: boolean;
  serviceWorker: boolean;
  cacheStorage: boolean;
  online: boolean;
}

/** Snapshot of the browser capabilities Paranoid Mode / sync rely on. */
export function detectFeatures(): FeatureReport {
  const w = typeof window !== 'undefined' ? window : undefined;
  return {
    secureContext: typeof isSecureContext !== 'undefined' ? isSecureContext : false,
    cryptoSubtle: typeof crypto !== 'undefined' && !!crypto.subtle,
    indexedDB: typeof indexedDB !== 'undefined',
    webAuthn: !!w && typeof w.PublicKeyCredential !== 'undefined' && !!navigator.credentials,
    webAuthnPrfPossible: !!w && typeof w.PublicKeyCredential !== 'undefined',
    idleDetector: !!w && 'IdleDetector' in w,
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    cacheStorage: typeof caches !== 'undefined',
    online: typeof navigator === 'undefined' || navigator.onLine !== false,
  };
}

export interface BuildInfo { version: string; commit: string }
export function getBuildInfo(): BuildInfo {
  return { version: APP_VERSION, commit: GIT_COMMIT };
}

/**
 * Ask the browser to persist storage so IndexedDB isn't evicted under pressure.
 * Best-effort and idempotent; returns whether storage is persisted afterwards.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch (err) {
    recordError('storage.persist', err);
    return false;
  }
}

export async function isStoragePersisted(): Promise<boolean | 'unknown'> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persisted) return 'unknown';
    return await navigator.storage.persisted();
  } catch {
    return 'unknown';
  }
}

export interface StorageEstimate { usage?: number; quota?: number }
export async function getStorageEstimate(): Promise<StorageEstimate> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return {};
    const e = await navigator.storage.estimate();
    return { usage: e.usage, quota: e.quota };
  } catch {
    return {};
  }
}

/** Unregister all service workers and reload — recovery from a wedged/stale SW. */
export async function forceServiceWorkerUpdate(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update().catch(() => r.unregister())));
    }
  } catch (err) {
    recordError('sw.forceUpdate', err);
  } finally {
    if (typeof window !== 'undefined') {
      try { window.location.reload(); } catch { /* no-op */ }
    }
  }
}
