import { useEffect, useCallback, useRef, createContext, useContext, type ReactNode } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

const UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_UPDATE_CHECK_MS = 10 * 60 * 1000; // 10 minutes — debounce visibility checks
const RELOAD_FALLBACK_MS = 12_000;          // only fires if controllerchange never does

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
  checkForUpdate: () => void; // debounced (focus/visibility/interval)
  forceCheck: () => void;     // immediate, user-initiated
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

  const checkForUpdate = useCallback(() => {
    const now = Date.now();
    if (now - lastCheckRef.current < MIN_UPDATE_CHECK_MS) return;
    lastCheckRef.current = now;
    registrationRef.current?.update();
  }, []);

  // Immediate, non-debounced check for a user-initiated "check for updates" button.
  const forceCheck = useCallback(() => {
    lastCheckRef.current = Date.now();
    registrationRef.current?.update();
  }, []);

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
  forceCheck: () => {},
};

// Returns a no-op API when rendered outside the provider (e.g. in unit tests),
// so consumers never crash for lack of a provider.
export function useServiceWorker(): ServiceWorkerApi {
  return useContext(ServiceWorkerContext) ?? NOOP_SW;
}
