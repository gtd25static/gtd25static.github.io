import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../db';
import { isRemoteUnlockEnrolled } from '../db/vault';
import { isParanoidFlagSet } from '../db/paranoid-flag';
import { jitterInterval } from '../sync/poll-jitter';
import { getCachedSalt } from '../sync/crypto';
import { recordError } from '../lib/diagnostics';
import { classifySyncError } from '../sync/sync-errors';
import { toast } from '../components/ui/Toast';
import { setApprovalState } from '../lib/approval-gate';
import {
  getMailboxPat, getRepo, requestRemoteUnlock, pollRemoteUnlock, pollRemoteCommands, cancelRemoteUnlock,
  expirePendingUnlock, hasPendingUnlock, refreshRegistryHeartbeat,
  pollApproverInbox, listApprovedDevices, readPendingApproval, approveRemoteUnlock, publishOwnRegistryEntry,
  dropDecommissionedDevices, recordRemoteDenial,
} from '../sync/remote-unlock';

const SLOW_POLL_MS = 12_000;   // background cadence (wipe watch / invitations)
// Wipe watch while the app is hidden: ~30 checks an hour instead of ~300 from a
// window nobody is looking at. A wipe then lands typically within ~2.5 min, up to
// ~4 with browser throttling (~16 s visible); bringing the window forward checks
// at once.
const HIDDEN_WIPE_POLL_MS = 120_000;
const FAST_POLL_MS = 2_500;    // while an unlock request is pending — keeps approval snappy
const REFOCUS_POLL_AFTER_MS = 60_000; // only force a poll on refocus after this long hidden
const DECOMMISSION_CHECK_MS = 60_000; // how often the approver tick looks for forgotten devices

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

// setInterval replacement that re-randomizes its delay each tick. In Paranoid Mode
// jitterInterval spreads the cadence ±30% so the mailbox poll isn't a fixed-period
// beacon; non-paranoid keeps the flat base interval. The base may be a function,
// read at each tick. Does not fire immediately — callers run() once up front,
// mirroring the previous setInterval behavior.
function startJitteredInterval(run: () => void, baseMs: number | (() => number)): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const loop = () => {
    if (stopped) return;
    timer = setTimeout(() => { run(); loop(); }, jitterInterval(typeof baseMs === 'function' ? baseMs() : baseMs));
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

  // One poll at a time: at the fast cadence against 15 s timeouts, a dead link
  // used to pile up half a dozen requests.
  const inFlight = useRef(false);
  const tick = useCallback(async () => {
    const c = ctx.current;
    if (!c || inFlight.current) return;
    if (pending.current) {
      inFlight.current = true;
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
      } catch { /* transient */ } finally {
        inFlight.current = false;
      }
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

  // The lock screen unmounting means the vault opened some other way (passphrase,
  // security key) — or the tab is going. The polling stops with it, so nothing
  // would ever enforce the request's TTL again: the ephemeral session key K would
  // sit in the module for the rest of the page's life, across later locks, and the
  // ceremony files would stay in the repo. Tear the request down here instead.
  // Unmount-only on purpose: the polling effect above re-runs whenever `code`
  // changes, and cancelling there would kill the request as it is created.
  useEffect(() => () => {
    if (!hasPendingUnlock()) return;
    const c = ctx.current;
    cancelRemoteUnlock(); // zero K first; the remote cleanup is best-effort
    if (c) void expirePendingUnlock(c.pat, c.repo, c.deviceId).catch((err) => recordError('remoteUnlock.abandon', err));
  }, []);

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
      let w: Awaited<ReturnType<typeof pollRemoteCommands>>;
      try {
        w = await pollRemoteCommands(ctx.pat, ctx.repo, ctx.deviceId, etag.current);
      } catch (err) {
        // A refused token is not transient: noted, or the device was silently out
        // of reach of a remote wipe while Settings still said "Enabled".
        if (classifySyncError(err).category === 'auth') {
          await db.localSettings.update('local', { remoteWipeTokenRejectedAt: Date.now() });
        }
        throw err;
      }
      if ((await db.localSettings.get('local'))?.remoteWipeTokenRejectedAt) {
        await db.localSettings.update('local', { remoteWipeTokenRejectedAt: undefined });
      }
      etag.current = w.etag;
      // While unlocked, refresh the registry entry at most daily, so the trusted
      // devices can show when this one was last seen (a no-op while locked).
      if (!w.wiped) await refreshRegistryHeartbeat().catch((err) => recordError('remoteUnlock.heartbeat', err));
    } catch {
      // Transient DB/network errors are retried on the next cadence.
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const run = () => { if (!stopped) void tick(); };
    const cadence = () => (isHidden() ? HIDDEN_WIPE_POLL_MS : SLOW_POLL_MS);
    run();
    let stop = startJitteredInterval(run, cadence);
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      run();
      // Back to the visible pace now, not when a hidden-length timer runs out.
      stop();
      stop = startJitteredInterval(run, cadence);
    };
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
/** A request from a device whose requests are paused (one was declined a moment ago). */
export interface HeldRequest extends ApprovalRequest { heldUntil: number }

const expired = (req: ApprovalRequest): boolean => Date.now() >= req.expiresAt;
const expiredMessage = (req: ApprovalRequest): string => `Unlock request from “${req.fromName}” expired`;

/**
 * Approver-side hook (NON-Paranoid devices): accept RUK invites and surface a
 * pending unlock request for a managed device so the UI can show an attention-
 * grabbing prompt. Several trusted devices may receive the same request, so a
 * prompt auto-dismisses once the request expires OR another device handles it
 * (the requester deletes the request on success) — with a toast explaining why,
 * deferred until the app is focused. Polls only while visible; on regaining focus
 * after ≥1 min hidden it forces a catch-up poll (quick toggles don't hammer the API).
 *
 * A request from a device declined a moment ago is HELD: a line, not the prompt,
 * until the user asks to see it. Expiry is judged on the wall clock (timers stand
 * still while the device sleeps): a Deny on an expired request only closes it.
 * Tells the update prompt to wait (lib/approval-gate) while it looks for requests
 * and while one is on screen.
 */
export function useRemoteApprovals(): {
  pending: ApprovalRequest | null;
  held: HeldRequest | null;
  approve: () => Promise<void>;
  deny: () => void;
  showHeld: () => void;
  ignoreHeld: () => void;
} {
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  const [held, setHeld] = useState<HeldRequest | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const busy = useRef(false);
  // The salt this device's registry entry was last published under: a sync-password
  // change re-MACs the registry, and an entry under the old key reads as forged.
  const publishedForSalt = useRef<string | null>(null);
  const current = useRef<ApprovalRequest | null>(null); // mirror of `pending` for callbacks
  const heldRef = useRef<HeldRequest | null>(null);     // mirror of `held`
  // Per device, the pause the user lifted by asking to see a held request (its
  // heldUntil). Memory only: a new denial starts a new pause, held again.
  const lifted = useRef<Map<string, number>>(new Map());
  // A look for requests the update prompt waits for (opening the app, coming back).
  const checking = useRef(true);
  const deferredToast = useRef<string | null>(null);     // shown on next focus
  const lastDecommissionCheck = useRef(0);

  // Only the prompt holds the update back: a held line sits above it (and is
  // signed by a key a disk image holds — it must not be able to block updates).
  const publish = useCallback(() => {
    setApprovalState(checking.current ? 'checking' : current.current ? 'request' : 'idle');
  }, []);

  const setHeldRequest = useCallback((next: HeldRequest | null) => {
    heldRef.current = next;
    setHeld(next);
  }, []);

  // Clear the on-screen prompt. Toast now if focused; otherwise defer to refocus.
  const dismiss = useCallback((toastMsg: string | null) => {
    const cur = current.current;
    if (cur) seen.current.add(cur.nonce);
    current.current = null;
    setPending(null);
    publish();
    if (toastMsg) {
      if (!isHidden()) toast(toastMsg, 'info');
      else deferredToast.current = toastMsg;
    }
  }, [publish]);

  const tick = useCallback(async () => {
    if (isParanoidFlagSet()) {
      checking.current = false;
      publish();
      return;
    }
    if (busy.current || isHidden()) return;
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
        if (current.current !== cur) return; // answered meanwhile
        if (!still || still.nonce !== cur.nonce || still.requestDigest !== cur.requestDigest || expired(cur)) {
          dismiss(expired(cur)
            ? expiredMessage(cur)
            : `Unlock request from “${cur.fromName}” was handled by another device`);
        }
        return;
      }

      const salt = getCachedSalt();
      if (salt && publishedForSalt.current !== salt && await publishOwnRegistryEntry()) publishedForSalt.current = salt;
      await pollApproverInbox(pat, repo, myId);
      // Devices another trusted device forgot (maybe stolen): stop showing their
      // requests here too, without waiting for someone to open the Settings.
      if (Date.now() - lastDecommissionCheck.current >= DECOMMISSION_CHECK_MS) {
        lastDecommissionCheck.current = Date.now();
        await dropDecommissionedDevices(pat, repo);
      }
      const managed = await listApprovedDevices();
      let heldBack: HeldRequest | null = null;
      for (const m of managed) {
        const p = await readPendingApproval(pat, repo, m.deviceId);
        if (!p || seen.current.has(p.nonce)) continue;
        const req: ApprovalRequest = { deviceId: m.deviceId, fromName: p.fromName, nonce: p.nonce, code: p.code, expiresAt: p.expiresAt, requestDigest: p.requestDigest };
        if (p.heldUntil && lifted.current.get(m.deviceId) !== p.heldUntil) {
          heldBack ??= { ...req, heldUntil: p.heldUntil };
          continue;
        }
        current.current = req;
        setPending(req);
        break;
      }
      // Re-read every tick: a held request that expired or was answered elsewhere goes.
      setHeldRequest(current.current ? null : heldBack);
    } catch (err) {
      // Mostly transient network/db errors, but a PERSISTENT failure means this
      // device silently stops approving unlocks — keep it visible in diagnostics.
      recordError('remoteUnlock.approverTick', err);
    } finally {
      busy.current = false;
      checking.current = false;
      publish();
    }
  }, [dismiss, publish, setHeldRequest]);

  useEffect(() => {
    let stop = false;
    let lastHidden = 0;
    const run = () => { if (!stop) void tick(); };
    publish(); // 'checking' until the first look is done
    run();
    const stopTimer = startJitteredInterval(run, SLOW_POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'hidden') { lastHidden = Date.now(); return; }
      if (deferredToast.current) { toast(deferredToast.current, 'info'); deferredToast.current = null; }
      // Back from a sleep, a request may have run out with its timer standing still.
      const cur = current.current;
      if (cur && expired(cur)) dismiss(expiredMessage(cur));
      if (heldRef.current && expired(heldRef.current)) { setHeldRequest(null); publish(); }
      // Always revalidate a showing prompt on refocus; otherwise only catch up after a
      // real absence — and that counts as opening the app: the update prompt waits.
      if (Date.now() - lastHidden >= REFOCUS_POLL_AFTER_MS) {
        checking.current = true;
        publish();
        run();
      } else if (current.current) {
        run();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', run);
    return () => {
      stop = true;
      stopTimer();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', run);
      setApprovalState('idle'); // nothing left to wait for
    };
  }, [tick, dismiss, publish, setHeldRequest]);

  // Auto-expire the showing prompt, or the held line, even while focused/idle (no poll needed).
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => {
      dismiss(expiredMessage(pending));
    }, Math.max(0, pending.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [pending, dismiss]);

  useEffect(() => {
    if (!held) return;
    const t = setTimeout(() => {
      setHeldRequest(null);
      publish();
    }, Math.max(0, held.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [held, setHeldRequest, publish]);

  const approve = useCallback(async () => {
    const p = current.current;
    if (!p) return;
    if (expired(p)) {
      dismiss(expiredMessage(p));
      return;
    }
    try {
      const local = await db.localSettings.get('local');
      if (local?.githubPat && local.githubRepo) await approveRemoteUnlock(local.githubPat, local.githubRepo, p.deviceId, p.requestDigest);
    } catch (err) {
      // Two of the throws here are the ACR-001 defence firing: the request was
      // swapped after the code was shown, or its signature does not verify.
      // Swallowing them made an active substitution attack look exactly like a
      // normal approval to the one human in the loop.
      recordError('remoteUnlock.approve', err);
      const msg = err instanceof Error ? err.message : '';
      toast(
        /changed since it was shown|signature is invalid/.test(msg)
          ? `Approval aborted — ${msg}. Ask the other device to start a new request.`
          : 'Could not send the approval — the other device can request again.',
        'error',
      );
    } finally {
      dismiss(null);
    }
  }, [dismiss]);

  // A denial is remembered: that device's requests pause, and Settings warns that
  // a request you did not expect means its key is likely out. Not for a request
  // that already ran out: it can no longer be approved, so Deny only closes it —
  // pausing there held back the next, real request with nothing said anywhere.
  const deny = useCallback(() => {
    const cur = current.current;
    if (cur && expired(cur)) {
      dismiss(expiredMessage(cur));
      return;
    }
    if (cur) void recordRemoteDenial(cur.deviceId).catch((err) => recordError('remoteUnlock.deny', err));
    dismiss(null);
  }, [dismiss]);

  // Lift the pause for the device whose request is held, and show the request.
  const showHeld = useCallback(() => {
    const h = heldRef.current;
    if (!h) return;
    setHeldRequest(null);
    if (expired(h)) {
      publish();
      toast(expiredMessage(h), 'info');
      return;
    }
    lifted.current.set(h.deviceId, h.heldUntil);
    const req: ApprovalRequest = { deviceId: h.deviceId, fromName: h.fromName, nonce: h.nonce, code: h.code, expiresAt: h.expiresAt, requestDigest: h.requestDigest };
    current.current = req;
    setPending(req);
    publish();
  }, [publish, setHeldRequest]);

  // Not a denial: this request stops showing, the pause runs as it was.
  const ignoreHeld = useCallback(() => {
    const h = heldRef.current;
    if (!h) return;
    seen.current.add(h.nonce);
    setHeldRequest(null);
    publish();
  }, [publish, setHeldRequest]);

  return { pending, held, approve, deny, showHeld, ignoreHeld };
}
