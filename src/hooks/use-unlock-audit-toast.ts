import { useEffect } from 'react';
import { db } from '../db';
import { isParanoidEnabled } from '../db/vault';
import { failedSinceLastSuccess, previousSuccess } from '../lib/unlock-audit';
import { toast } from '../components/ui/Toast';

// Paranoid extra (opt-in): once per unlock, surface the audit trail as a toast
// — "Last unlock <when> · N failed attempts since" — so tampering in your
// absence is visible. Mounted in UnlockedApp, so it runs exactly once per
// unlock (this component mounts on the locked → unlocked transition).
export function useUnlockAuditToast(): void {
  useEffect(() => {
    if (!isParanoidEnabled()) return;
    let cancelled = false;
    void (async () => {
      const local = await db.localSettings.get('local');
      if (cancelled || !local?.paranoidUnlockLogEnabled) return;
      const log = local.unlockLog ?? [];
      const failed = failedSinceLastSuccess(log.slice(0, -1)); // exclude the unlock that just happened
      const prev = previousSuccess(log);
      const when = prev ? new Date(prev.at).toLocaleString() : 'first unlock on this device';
      const suffix = failed > 0 ? ` · ${failed} failed attempt${failed === 1 ? '' : 's'} since` : '';
      toast(`Last unlock: ${when}${suffix}`, failed > 0 ? 'error' : 'info');
    })();
    return () => { cancelled = true; };
  }, []);
}
