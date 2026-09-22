import { useEffect, useCallback, useRef, createContext, useContext, type ReactNode } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { GIT_COMMIT } from '../lib/constants';
import { fetchDeployedVersion } from '../lib/changelog';

const UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_UPDATE_CHECK_MS = 10 * 60 * 1000; // 10 minutes — debounce visibility checks
const RELOAD_FALLBACK_MS = 12_000;          // only fires if controllerchange never does
// registration.update() has no deadline of its own: a blocked or proxied network
// can leave it pending for as long as the page lives. Past this we report a
// check that did not complete, rather than one that found nothing.
const UPDATE_CHECK_TIMEOUT_MS = 15_000;

/**
 * What a check actually found. The distinctions are the point: "nothing new"
 * and "I could not tell" used to be indistinguishable to the user, so a device
 * whose worker was stuck kept reporting itself up to date while running a build
 * from weeks earlier.
 */
export type UpdateCheckResult =
  | 'update-found'  // a new build is installing or waiting; the update prompt takes over
  | 'up-to-date'    // the check ran, and the deployed build is the one running
  | 'stale-worker'  // the server has another build, but the worker did not take it
  | 'no-worker'     // nothing is registered here, so the app cannot update itself
  | 'failed';       // the check did not complete (offline, blocked, timed out)

async function currentRegistration(
  cached: ServiceWorkerRegistration | undefined,
): Promise<ServiceWorkerRegistration | undefined> {
  if (cached) return cached;
  // onRegisteredSW may not have fired yet — or at all, if registration failed.
  // Ask the browser rather than calling it "no worker" on a timing accident.
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return undefined;
  try {
    return await navigator.serviceWorker.getRegistration();
  } catch {
    return undefined;
  }
}

/** registration.update(), bounded. False when it outran the timeout. */
async function updateWithinTimeout(registration: ServiceWorkerRegistration): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      registration.update().then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), UPDATE_CHECK_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Module-level guard: the page reloads AT MOST ONCE per life, regardless of which
// path (the plugin's controllerchange reload, or our fallback timer) fires first.
// This is what prevents the Safari "Update now" loop — the old code force-reloaded
// after 2s AND let the plugin reload on controllerchange, so the two raced: the 2s
// reload interrupted skipWaiting/activation before the new SW could take control,
// leaving it "waiting" forever and re-showing the banner.
let reloadArmed = false;
function reloadOnce() {
  if (reloadArmed) return;
  reloadArmed = true;
  try { window.location.reload(); } catch { /* no-op */ }
}

export interface ServiceWorkerApi {
  needRefresh: boolean;
  applyUpdate: () => void;
  checkForUpdate: () => void;                   // debounced (focus/visibility/interval)
  forceCheck: () => Promise<UpdateCheckResult>; // immediate, user-initiated, awaited
}

function useServiceWorkerImpl(): ServiceWorkerApi {
  const registrationRef = useRef<ServiceWorkerRegistration | undefined>(undefined);
  const lastCheckRef = useRef(0);

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      registrationRef.current = registration;
    },
  });

  // One implementation for both entry points, so the background check and the
  // user-initiated one can never disagree about what counts as up to date.
  const runCheck = useCallback(async (): Promise<UpdateCheckResult> => {
    lastCheckRef.current = Date.now();
    const registration = await currentRegistration(registrationRef.current);
    if (!registration) return 'no-worker';
    registrationRef.current = registration;

    let completed: boolean;
    try {
      completed = await updateWithinTimeout(registration);
    } catch {
      return 'failed'; // the browser could not fetch or install the new script
    }
    if (registration.installing || registration.waiting) return 'update-found';
    if (!completed) return 'failed';

    // The worker found nothing. Believe that only if the server agrees: a worker
    // that is stuck, or whose script the network is rewriting, reports exactly
    // the same "nothing new" as one that is genuinely current. When the live
    // file is unreachable we say nothing new either, rather than cry wolf.
    const deployed = await fetchDeployedVersion();
    return deployed && deployed.commit !== GIT_COMMIT ? 'stale-worker' : 'up-to-date';
  }, []);

  const checkForUpdate = useCallback(() => {
    if (Date.now() - lastCheckRef.current < MIN_UPDATE_CHECK_MS) return;
    void runCheck();
  }, [runCheck]);

  /** Immediate, non-debounced check that resolves with what it found. */
  const forceCheck = useCallback(() => runCheck(), [runCheck]);

  // Apply a waiting update. updateServiceWorker(true) sends SKIP_WAITING and
  // reloads on controllerchange. We add only a LONG, guarded fallback for
  // environments where controllerchange never fires (some standalone PWAs) —
  // never a short timer that could race the normal activation.
  const applyUpdate = useCallback(() => {
    if (reloadArmed) return;
    updateServiceWorker(true);
    setTimeout(reloadOnce, RELOAD_FALLBACK_MS);
  }, [updateServiceWorker]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Check on window focus (covers standalone PWA restore).
    window.addEventListener('focus', checkForUpdate);
    // Check every 30 minutes.
    const interval = setInterval(checkForUpdate, UPDATE_INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', checkForUpdate);
      clearInterval(interval);
    };
  }, [checkForUpdate]);

  return { needRefresh, applyUpdate, checkForUpdate, forceCheck };
}

// Single SW registration + update detection for the whole app, provided from the
// ALWAYS-mounted App so it keeps running while the vault is locked — letting a
// user stuck on a buggy locked build pull a fix without wiping their data.
const ServiceWorkerContext = createContext<ServiceWorkerApi | null>(null);

export function ServiceWorkerProvider({ children }: { children: ReactNode }) {
  const api = useServiceWorkerImpl();
  return <ServiceWorkerContext.Provider value={api}>{children}</ServiceWorkerContext.Provider>;
}

const NOOP_SW: ServiceWorkerApi = {
  needRefresh: false,
  applyUpdate: () => {},
  checkForUpdate: () => {},
  forceCheck: () => Promise.resolve('no-worker'),
};

// Returns a no-op API when rendered outside the provider (e.g. in unit tests),
// so consumers never crash for lack of a provider.
export function useServiceWorker(): ServiceWorkerApi {
  return useContext(ServiceWorkerContext) ?? NOOP_SW;
}
