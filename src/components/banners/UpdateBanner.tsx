import { useState, useEffect } from 'react';
import { onVersionIncompatible, offVersionIncompatible } from '../../sync/sync-engine';

export function UpdateBanner() {
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    const handler = () => setShowBanner(true);
    onVersionIncompatible(handler);
    return () => offVersionIncompatible(handler);
  }, []);

  if (!showBanner) return null;

  return (
    <div className="flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-white">
      <span>A newer version of GTD25 is required to sync. Please update.</span>
      <button
        onClick={() => window.location.reload()}
        className="shrink-0 rounded-md bg-white/20 px-3 py-1 text-xs font-bold hover:bg-white/30"
      >
        Reload
      </button>
    </div>
  );
}
