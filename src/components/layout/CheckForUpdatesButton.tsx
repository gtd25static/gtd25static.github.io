import { useState, useRef, useEffect } from 'react';
import { useServiceWorker } from '../../hooks/use-service-worker';
import { toast } from '../ui/Toast';

// How long to wait for the service worker to surface a waiting build before we
// reassure the user they're current. A found build flips `needRefresh` and the
// always-mounted AppUpdatePrompt shows the update dialog instead.
const DETECT_WINDOW_MS = 4000;

interface Props {
  /** Called when a check starts — e.g. to close the sidebar on mobile. */
  onActivate?: () => void;
}

/** Sidebar action that triggers an immediate, user-initiated update check. */
export function CheckForUpdatesButton({ onActivate }: Props) {
  const { needRefresh, forceCheck } = useServiceWorker();
  const [checking, setChecking] = useState(false);
  // Read the latest needRefresh inside the post-check timeout without staleness.
  const needRefreshRef = useRef(needRefresh);
  useEffect(() => { needRefreshRef.current = needRefresh; }, [needRefresh]);

  function handleClick() {
    if (checking) return;
    setChecking(true);
    onActivate?.();
    forceCheck(); // if a new build exists, AppUpdatePrompt shows the update dialog
    setTimeout(() => {
      setChecking(false);
      if (!needRefreshRef.current) toast('You’re on the latest version', 'success');
    }, DETECT_WINDOW_MS);
  }

  return (
    <button
      onClick={handleClick}
      disabled={checking}
      className="flex w-full items-center gap-3 rounded-full px-3 py-3.5 md:py-2 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-60 dark:text-zinc-400 dark:hover:bg-zinc-800"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={checking ? 'animate-spin' : ''}>
        <path d="M20 11A8 8 0 005.3 6.3M4 13a8 8 0 0014.7 4.7" strokeLinecap="round" />
        <path d="M20 4v4h-4M4 20v-4h4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="flex-1 text-left">{checking ? 'Checking…' : 'Check for app updates'}</span>
    </button>
  );
}
