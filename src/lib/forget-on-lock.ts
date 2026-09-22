import { subscribeVault, getVaultSnapshot } from '../db/vault';
import { endSyncSession } from '../sync/sync-engine';
import { useAppState } from '../stores/app-state';
import { dismissFocusNudge } from '../stores/focus-nudge';
import { forgetPendingClipboardText } from './clipboard-hygiene';
import { revokeSessionObjectUrls } from './session-object-urls';
import { closeAllNotifications } from './notifications';

// Locking forgets what the session held in memory. These stores and the sync
// engine's session outlive the unlocked UI, so without this the next unlock —
// possibly with the secondary passphrase, over placeholder content — got the last
// search back ("No results for …"), a nudge dialog naming a real task, or a sync
// still running on the previous session's credentials.

/** Forget on every lock of this tab's vault. Returns an unsubscribe. */
export function startForgettingSessionOnLock(): () => void {
  return subscribeVault(() => {
    // A re-key (`busy`) forgets the session too: the content is about to be
    // rewritten under another key, and a sync in flight must not write around it.
    const { enabled, unlocked, busy } = getVaultSnapshot();
    if (!enabled || (unlocked && !busy)) return;
    endSyncSession();
    useAppState.getState().setSearchQuery('');
    dismissFocusNudge();
    // Two retainers of decrypted content that outlive the DEK: the text held for
    // the clipboard auto-clear's comparison, and any blob: URL still resolvable
    // from this origin (a shared-folder download keeps one alive for a minute).
    forgetPendingClipboardText();
    revokeSessionObjectUrls();
    // A nudge left in the notification centre names a task after the lock.
    void closeAllNotifications();
  });
}
