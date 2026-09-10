import { subscribeVault, getVaultSnapshot } from '../db/vault';
import { endSyncSession } from '../sync/sync-engine';
import { useAppState } from '../stores/app-state';
import { dismissFocusNudge } from '../stores/focus-nudge';

// Locking forgets what the session held in memory. These stores and the sync
// engine's session outlive the unlocked UI, so without this the next unlock —
// possibly with the secondary passphrase, over placeholder content — got the last
// search back ("No results for …"), a nudge dialog naming a real task, or a sync
// still running on the previous session's credentials.

/** Forget on every lock of this tab's vault. Returns an unsubscribe. */
export function startForgettingSessionOnLock(): () => void {
  return subscribeVault(() => {
    const { enabled, unlocked } = getVaultSnapshot();
    if (!enabled || unlocked) return;
    endSyncSession();
    useAppState.getState().setSearchQuery('');
    dismissFocusNudge();
  });
}
