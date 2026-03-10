import { useState, useEffect } from 'react';
import { onVersionIncompatible, offVersionIncompatible } from '../../sync/sync-engine';
import { useServiceWorker } from '../../hooks/use-service-worker';

export function UpdateBanner() {
  const [syncIncompat, setSyncIncompat] = useState(false);
  const { needRefresh, updateServiceWorker, checkForUpdate } = useServiceWorker();

  useEffect(() => {
    const handler = () => {
      setSyncIncompat(true);
      checkForUpdate();
    };
    onVersionIncompatible(handler);
    return () => offVersionIncompatible(handler);
  }, [checkForUpdate]);

  if (!syncIncompat && !needRefresh) return null;

  const message = syncIncompat
    ? 'A newer version of GTD25 is required to sync. Please update.'
    : 'A new version of GTD25 is available.';

  const handleClick = () => {
    if (needRefresh) {
      updateServiceWorker();
    } else {
      window.location.reload();
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-white">
      <span>{message}</span>
      <button
        onClick={handleClick}
        className="shrink-0 rounded-md bg-white/20 px-3 py-1 text-xs font-bold hover:bg-white/30"
      >
        {needRefresh ? 'Update now' : 'Reload'}
      </button>
    </div>
  );
}
