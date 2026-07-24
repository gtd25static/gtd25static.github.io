import { useCallback, useEffect, useState } from 'react';
import { db } from '../db';
import { isParanoidEnabled } from '../db/vault';
import { failedEntriesSinceLastSuccess, previousSuccess, type UnlockLogEntry } from '../lib/unlock-audit';
import { toast } from '../components/ui/Toast';

export interface UnlockAuditAlertData {
  /** Failed attempts since the previous successful unlock, oldest first. */
  failed: UnlockLogEntry[];
  /** When this device was last unlocked before now; null on a first unlock. */
  previousUnlockAt: number | null;
}

export interface UnlockAuditApi {
  /** Set only when failed attempts happened since last time; null otherwise. */
  alert: UnlockAuditAlertData | null;
  dismiss: () => void;
}

// Paranoid extra (opt-in): once per unlock, surface the audit trail so tampering
// in your absence is visible. A clean unlock is a quiet toast ("Last unlock: …");
// failed attempts since last time raise a DIALOG the user has to acknowledge —
// a toast auto-dismisses, and the one signal you must not miss is somebody
// having tried your passphrase while you were away.
//
// Mounted in UnlockedApp, so it runs exactly once per unlock (this component
// mounts on the locked → unlocked transition).
export function useUnlockAudit(): UnlockAuditApi {
  const [alert, setAlert] = useState<UnlockAuditAlertData | null>(null);

  useEffect(() => {
    if (!isParanoidEnabled()) return;
    let cancelled = false;
    void (async () => {
      const local = await db.localSettings.get('local');
      if (cancelled || !local?.paranoidUnlockLogEnabled) return;
      const log = local.unlockLog ?? [];
      // Exclude the unlock that just happened — it is the last entry.
      const failed = failedEntriesSinceLastSuccess(log.slice(0, -1));
      const prev = previousSuccess(log);
      if (failed.length > 0) {
        setAlert({ failed, previousUnlockAt: prev?.at ?? null });
        return;
      }
      const when = prev ? new Date(prev.at).toLocaleString() : 'first unlock on this device';
      toast(`Last unlock: ${when}`, 'info');
    })();
    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback(() => setAlert(null), []);

  return { alert, dismiss };
}
