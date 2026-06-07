import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../db';
import { isRemoteUnlockEnrolled } from '../db/vault';
import { isParanoidFlagSet } from '../db/paranoid-flag';
import { confirmDialog } from '../components/ui/ConfirmDialog';
import {
  getMailboxPat, getRepo, requestRemoteUnlock, pollRemoteUnlock, pollRemoteCommands, cancelRemoteUnlock,
  pollApproverInbox, listApprovedDevices, readPendingApproval, approveRemoteUnlock, publishOwnRegistryEntry,
} from '../sync/remote-unlock';

const POLL_MS = 12_000;

/**
 * Lock-screen hook: when this device has remote unlock enrolled, run a cheap
 * (conditional-ETag) background poll for a signed remote-WIPE command, and expose
 * a request/cancel flow for remote UNLOCK (showing the verification code to match
 * on the approving device). On a successful unlock the vault emits and the lock
 * screen unmounts; on a wipe, panicWipe reloads.
 */
export function useLockScreenRemote() {
  const [enrolled, setEnrolled] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const ctx = useRef<{ pat: string; repo: string; deviceId: string } | null>(null);
  const reqEtag = useRef<string | null>(null);
  const cmdEtag = useRef<string | null>(null);
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
    try {
      const w = await pollRemoteCommands(c.pat, c.repo, c.deviceId, cmdEtag.current);
      cmdEtag.current = w.etag;
      if (w.wiped) return; // panicWipe reloads the page
    } catch { /* transient network — keep polling */ }
    if (pending.current) {
      try {
        const r = await pollRemoteUnlock(c.pat, c.repo, c.deviceId, reqEtag.current);
        reqEtag.current = r.etag;
        // On 'unlocked' the vault emits -> the gate unmounts this screen.
      } catch { /* transient */ }
    }
  }, []);

  useEffect(() => {
    if (!enrolled) return;
    const run = () => { void tick(); };
    run();
    const timer = setInterval(run, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') run(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', run);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', run);
    };
  }, [enrolled, tick]);

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

/**
 * Approver-side watcher (mounted in the unlocked app): on a NON-Paranoid device,
 * periodically accept RUK invites and surface a confirm prompt (with the matching
 * verification code) for any pending unlock request from a managed device. A
 * Paranoid device never acts as an approver.
 */
export function useRemoteApprovalWatcher() {
  const seen = useRef<Set<string>>(new Set());
  const busy = useRef(false);
  const published = useRef(false);

  useEffect(() => {
    let stop = false;
    async function tick() {
      if (stop || busy.current || isParanoidFlagSet()) return;
      busy.current = true;
      try {
        const local = await db.localSettings.get('local');
        const pat = local?.githubPat;
        const repo = local?.githubRepo;
        const myId = local?.deviceId;
        if (!pat || !repo || !myId) return;
        // Advertise this (non-Paranoid) device in the registry once per session so
        // Paranoid devices can discover + trust it as an approver candidate.
        if (!published.current) published.current = await publishOwnRegistryEntry();
        await pollApproverInbox(pat, repo, myId);
        const managed = await listApprovedDevices();
        for (const m of managed) {
          const p = await readPendingApproval(pat, repo, m.deviceId);
          if (!p || seen.current.has(p.nonce)) continue;
          seen.current.add(p.nonce);
          const ok = await confirmDialog(
            `“${p.fromName}” is requesting a remote unlock. Approve ONLY if you started it and the code on that device matches:\n\n${p.code}`,
            { confirmLabel: 'Approve unlock', danger: true },
          );
          if (ok) await approveRemoteUnlock(pat, repo, m.deviceId);
        }
      } catch { /* transient */ } finally {
        busy.current = false;
      }
    }
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, []);
}
