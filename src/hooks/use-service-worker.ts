import { useEffect, useCallback, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

const UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_UPDATE_CHECK_MS = 10 * 60 * 1000; // 10 minutes — debounce visibility checks

export function useServiceWorker() {
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

  useEffect(() => {
    // Check on tab focus (debounced to at most once per 10 minutes)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Check on window focus (covers standalone PWA restore, where visibilitychange may not fire)
    window.addEventListener('focus', checkForUpdate);

    // Check every 30 minutes
    const interval = setInterval(checkForUpdate, UPDATE_INTERVAL_MS);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', checkForUpdate);
      clearInterval(interval);
    };
  }, [checkForUpdate]);

  return { needRefresh, updateServiceWorker, checkForUpdate };
}
