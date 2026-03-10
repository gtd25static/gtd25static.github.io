import { useEffect, useCallback, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

const UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export function useServiceWorker() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      registrationRef.current = registration;
    },
  });

  const registrationRef = useRef<ServiceWorkerRegistration | undefined>(undefined);

  const checkForUpdate = useCallback(() => {
    registrationRef.current?.update();
  }, []);

  useEffect(() => {
    // Check on tab focus
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Check every 30 minutes
    const interval = setInterval(checkForUpdate, UPDATE_INTERVAL_MS);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearInterval(interval);
    };
  }, [checkForUpdate]);

  return { needRefresh, updateServiceWorker, checkForUpdate };
}
