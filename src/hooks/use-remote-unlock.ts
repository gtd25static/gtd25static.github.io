import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../db';
import { isRemoteUnlockEnrolled } from '../db/vault';
import { isParanoidFlagSet } from '../db/paranoid-flag';
import { jitterInterval } from '../sync/poll-jitter';
import { toast } from '../components/ui/Toast';
import {
  getMailboxPat, getRepo, requestRemoteUnlock, pollRemoteUnlock, pollRemoteCommands, cancelRemoteUnlock,
  pollApproverInbox, listApprovedDevices, readPendingApproval, approveRemoteUnlock, publishOwnRegistryEntry,
} from '../sync/remote-unlock';

const SLOW_POLL_MS = 12_000;   // background cadence (wipe watch / invitations)
const FAST_POLL_MS = 2_500;    // while an unlock request is pending — keeps approval snappy
const REFOCUS_POLL_AFTER_MS = 60_000; // only force a poll on refocus after this long hidden

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

// setInterval replacement that re-randomizes its delay each tick. In Paranoid Mode
// jitterInterval spreads the cadence ±30% so the mailbox poll isn't a fixed-period
// beacon; non-paranoid keeps the flat base interval. Does not fire immediately —
// callers run() once up front, mirroring the previous setInterval behavior.
function startJitteredInterval(run: () => void, baseMs: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const loop = () => {
    if (stopped) return;
    timer = setTimeout(() => { run(); loop(); }, jitterInterval(baseMs));
  };
  loop();
  return () => { stopped = true; clearTimeout(timer); };
}

/**
 * Lock-screen hook: when this device has remote unlock enrolled, poll (cheap,
 * conditional-ETag) for a signed remote-WIPE command, and expose a request/cancel
 * flow for remote UNLOCK with the verification code. While a request is pending we
 * poll fast so unlocking is near-instant after the approver authorizes.
 */
export function useLockScreenRemote() {
  const [enrolled, setEnrolled] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const ctx = useRef<{ pat: string; repo: string; deviceId: string } | null>(null);
  const reqEtag = useRef<string | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pat, repo, on] = await Promise.all([getMailboxPat(), getRepo(), isRemoteUnlockEnrolled()]);
        const local = await db.localSettings.get('local');
        if (cancelled) return;
        if (pat && repo && local?.deviceId && on) {
          ctx.current = { pat, repo, deviceId: local.deviceId };
          setEnrolled(true);
        }
      } catch { /* transient db/network (or test teardown) — stays disabled */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const tick = useCallback(async () => {
    const c = ctx.current;
    if (!c) return;
    if (pending.current) {
      try {
        const r = await pollRemoteUnlock(c.pat, c.repo, c.deviceId, reqEtag.current);
        reqEtag.current = r.etag;
        // On 'unlocked' the vault emits -> the gate unmounts this screen. On 'expired'
        // the requester-side TTL fired (ephemeral key wiped) — clear the prompt (ACR-006).
        if (r.status === 'expired') {
          pending.current = false;
          setCode(null);
          setError('Unlock request expired — request again');
        }
      } catch { /* transient */ }
    }
  }, []);

  useEffect(() => {
    if (!enrolled) return;
    const run = () => { void tick(); };
    run();
    const stop = startJitteredInterval(run, code ? FAST_POLL_MS : SLOW_POLL_MS); // fast while a request is pending
    const onVis = () => { if (document.visibilityState === 'visible') run(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', run);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', run);
    };
  }, [enrolled, code, tick]);

  const request = useCallback(async () => {
    const c = ctx.current;
    if (!c) return;
    setError('');
    try {
      const { code } = await requestRemoteUnlock(c.pat, c.repo, c.deviceId);
      reqEtag.current = null;
      pending.current = true;
      setCode(code);
      void tick();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the unlock request');
    }
  }, [tick]);

  const cancel = useCallback(() => {
    cancelRemoteUnlock();
    pending.current = false;
    setCode(null);
  }, []);

  return { enrolled, code, error, request, cancel };
}

async function loadRemoteWipeContext(): Promise<{ pat: string; repo: string; deviceId: string } | null> {
  if (!isParanoidFlagSet()) return null;
  const [pat, repo, on] = await Promise.all([getMailboxPat(), getRepo(), isRemoteUnlockEnrolled()]);
  const local = await db.localSettings.get('local');
  if (!pat || !repo || !local?.deviceId || !on) return null;
  return { pat, repo, deviceId: local.deviceId };
}

/**
 * Protected-device hook: poll for approver-signed remote wipe commands while the
 * app is open, whether the vault is locked or unlocked. It deliberately avoids
 * decrypted task data; it only uses the plaintext mailbox PAT kept for enrolled
 * remote unlock/wipe devices.
 */
export function useRemoteWipeCommands() {
  const etag = useRef<string | null>(null);
  const lastKey = useRef('');
  const busy = useRef(false);

  const tick = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const ctx = await loadRemoteWipeContext();
      if (!ctx) {
        etag.current = null;
        lastKey.current = '';
        return;
      }
      const key = `${ctx.repo}:${ctx.deviceId}`;
      if (key !== lastKey.current) {
        etag.current = null;
        lastKey.current = key;
      }
      const w = await pollRemoteCommands(ctx.pat, ctx.repo, ctx.deviceId, etag.current);
      etag.current = w.etag;
    } catch {
      // Transient DB/network errors are retried on the next cadence.
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const run = () => { if (!stopped) void tick(); };
    run();
    const stop = startJitteredInterval(run, SLOW_POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') run(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', run);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', run);
    };
  }, [tick]);
}

export interface ApprovalRequest { deviceId: string; fromName: string; nonce: string; code: string; expiresAt: number; requestDigest: string }

/**
 * Approver-side hook (NON-Paranoid devices): accept RUK invites and surface a
 * pending unlock request for a managed device so the UI can show an attention-
 * grabbing prompt. Several trusted devices may receive the same request, so a
 * prompt auto-dismisses once the request expires OR another device handles it
 * (the requester deletes the request on success) — with a toast explaining why,
 * deferred until the app is focused. Polls only while visible; on regaining focus
 * after ≥1 min hidden it forces a catch-up poll (quick toggles don't hammer the API).
 */
export function useRemoteApprovals(): { pending: ApprovalRequest | null; approve: () => Promise<void>; deny: () => void } {
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const busy = useRef(false);
  const published = useRef(false);
  const current = useRef<ApprovalRequest | null>(null); // mirror of `pending` for callbacks
  const deferredToast = useRef<string | null>(null);     // shown on next focus

  // Clear the on-screen prompt. Toast now if focused; otherwise defer to refocus.
  const dismiss = useCallback((toastMsg: string | null) => {
    const cur = current.current;
    if (cur) seen.current.add(cur.nonce);
    current.current = null;
    setPending(null);
    if (toastMsg) {
      if (!isHidden()) toast(toastMsg, 'info');
      else deferredToast.current = toastMsg;
    }
  }, []);

  const tick = useCallback(async () => {
    if (busy.current || isParanoidFlagSet() || isHidden()) return;
    busy.current = true;
    try {
      const local = await db.localSettings.get('local');
      const pat = local?.githubPat;
      const repo = local?.githubRepo;
      const myId = local?.deviceId;
      if (!pat || !repo || !myId) return;

      // A prompt is already showing -> revalidate it instead of searching for a new
      // one. If the request is gone (handled by another device) or expired, dismiss.
      const cur = current.current;
      if (cur) {
        const still = await readPendingApproval(pat, repo, cur.deviceId);
        if (!still || still.nonce !== cur.nonce || still.requestDigest !== cur.requestDigest) {
          dismiss(Date.now() >= cur.expiresAt
            ? `Unlock request from “${cur.fromName}” expired`
            : `Unlock request from “${cur.fromName}” was handled by another device`);
        }
        return;
      }

      if (!published.current) published.current = await publishOwnRegistryEntry();
      await pollApproverInbox(pat, repo, myId);
      const managed = await listApprovedDevices();
      for (const m of managed) {
        const p = await readPendingApproval(pat, repo, m.deviceId);
        if (p && !seen.current.has(p.nonce)) {
          const req: ApprovalRequest = { deviceId: m.deviceId, fromName: p.fromName, nonce: p.nonce, code: p.code, expiresAt: p.expiresAt, requestDigest: p.requestDigest };
          current.current = req;
          setPending(req);
          break;
        }
      }
    } catch { /* transient */ } finally {
      busy.current = false;
    }
  }, [dismiss]);

  useEffect(() => {
    let stop = false;
    let lastHidden = 0;
    const run = () => { if (!stop) void tick(); };
    run();
    const stopTimer = startJitteredInterval(run, SLOW_POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'hidden') { lastHidden = Date.now(); return; }
      if (deferredToast.current) { toast(deferredToast.current, 'info'); deferredToast.current = null; }
      // Always revalidate a showing prompt on refocus; otherwise only catch up after a real absence.
      if (current.current || Date.now() - lastHidden >= REFOCUS_POLL_AFTER_MS) run();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', run);
    return () => {
      stop = true;
      stopTimer();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', run);
    };
  }, [tick]);

  // Auto-expire the showing prompt even while focused/idle (no poll needed).
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => {
      dismiss(`Unlock request from “${pending.fromName}” expired`);
    }, Math.max(0, pending.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [pending, dismiss]);

  const approve = useCallback(async () => {
    const p = current.current;
    if (!p) return;
    try {
      const local = await db.localSettings.get('local');
      if (local?.githubPat && local.githubRepo) await approveRemoteUnlock(local.githubPat, local.githubRepo, p.deviceId, p.requestDigest);
    } catch { /* requester can retry */ } finally {
      dismiss(null);
    }
  }, [dismiss]);

  const deny = useCallback(() => { dismiss(null); }, [dismiss]);

  return { pending, approve, deny };
}
