import { useState } from 'react';
import { useServiceWorker, type UpdateCheckResult } from '../../hooks/use-service-worker';
import { toast } from '../ui/Toast';

const FORCE_UPDATE_HINT = 'Settings → Diagnostics → “Force update & reload”.';

// What to say about each outcome. A found build says nothing here: it flips
// needRefresh, and the always-mounted AppUpdatePrompt shows the update dialog.
//
// This used to be a 4-second timer over a fire-and-forget check: whatever went
// wrong — no registration at all, a request the network never answered — the
// button waited it out and then claimed the device was on the latest version.
function report(result: UpdateCheckResult): void {
  switch (result) {
    case 'update-found':
      return;
    case 'up-to-date':
      toast('You’re on the latest version', 'success');
      return;
    case 'stale-worker':
      toast(`A newer version is deployed, but this device did not pick it up. ${FORCE_UPDATE_HINT}`, 'error');
      return;
    case 'no-worker':
      toast(`This device can’t check for updates: nothing is registered to install them. ${FORCE_UPDATE_HINT}`, 'error');
      return;
    case 'failed':
      toast('Could not check for updates. You may be offline, or the network is blocking it.', 'error');
  }
}

interface Props {
  /** Called when a check starts — e.g. to close the sidebar on mobile. */
  onActivate?: () => void;
}

/** Sidebar action that triggers an immediate, user-initiated update check. */
export function CheckForUpdatesButton({ onActivate }: Props) {
  const { forceCheck } = useServiceWorker();
  const [checking, setChecking] = useState(false);

  async function handleClick() {
    if (checking) return;
    setChecking(true);
    onActivate?.();
    try {
      report(await forceCheck());
    } finally {
      setChecking(false);
    }
  }

  return (
    <button
      onClick={() => void handleClick()}
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
