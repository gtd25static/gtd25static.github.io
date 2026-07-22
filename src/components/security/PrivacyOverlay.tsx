import { useEffect, useRef, useState } from 'react';
import { getVaultIdleState, touchVaultActivity } from '../../db/vault';

// How often the foreground poll checks progress towards the idle lock. A poll
// (vs. a timer armed per-activity) needs no hook into every touchVaultActivity
// call site and self-corrects after background-tab timer throttling.
const POLL_MS = 2_000;
// The veil raises once this fraction of the idle window has passed untouched.
const SHOW_AT_FRACTION = 0.5;

// Privacy veil for Paranoid Mode (opt-in): while the vault is unlocked, blur
// the whole app when the tab goes to the background or when more than half of
// the idle window has elapsed without interaction — so an unattended-but-open
// screen shows nothing readable during the run-up to the auto-lock.
//
// Deterrence, not cryptography: the content is still in the DOM behind CSS.
// The auto-lock (which actually drops the DEK) is untouched underneath.
//
// Dismissing counts as vault activity (touchVaultActivity): a wake gesture is
// real interaction, and without re-arming, elapsed time would still exceed the
// threshold and the veil would re-raise on the next poll. pointermove is
// listened to ONLY while the veil is up — it never becomes a general activity
// source, so ACR-002 (only real interaction defers the lock) keeps its shape.
export function PrivacyOverlay() {
  const [veiled, setVeiled] = useState(false);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const veiledRef = useRef(veiled);
  veiledRef.current = veiled;

  // Raise: background immediately, foreground on the half-way poll.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') setVeiled(true);
    };
    const onBlur = () => setVeiled(true);
    const poll = setInterval(() => {
      if (veiledRef.current) return;
      const { lastActivityAt, timeoutMs } = getVaultIdleState();
      if (Date.now() - lastActivityAt > timeoutMs * SHOW_AT_FRACTION) setVeiled(true);
    }, POLL_MS);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', onBlur);
    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Dismiss on any deliberate return: movement, press, key, focus, tab visible.
  useEffect(() => {
    if (!veiled) return;
    const dismiss = () => {
      touchVaultActivity();
      setVeiled(false);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') dismiss();
    };
    window.addEventListener('pointermove', dismiss);
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', dismiss);
    window.addEventListener('focus', dismiss);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('pointermove', dismiss);
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', dismiss);
      window.removeEventListener('focus', dismiss);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [veiled]);

  // Countdown to the real auto-lock while the veil is up.
  useEffect(() => {
    if (!veiled) {
      setRemainingMs(null);
      return;
    }
    const update = () => {
      const { lastActivityAt, timeoutMs } = getVaultIdleState();
      setRemainingMs(Math.max(0, lastActivityAt + timeoutMs - Date.now()));
    };
    update();
    const tick = setInterval(update, 1_000);
    return () => clearInterval(tick);
  }, [veiled]);

  if (!veiled) return null;

  return (
    <div
      data-testid="privacy-overlay"
      // Above the app (incl. modals), below toasts' popover top layer.
      className="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-3 bg-white/60 backdrop-blur-2xl motion-safe:animate-[privacy-veil-in_150ms_ease-out] dark:bg-zinc-900/60"
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500 dark:text-zinc-400" aria-hidden>
        <rect x="4" y="10" width="16" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">Screen hidden for privacy</p>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        {remainingMs !== null && `Locking in ${formatMmSs(remainingMs)} — `}
        move the mouse or press a key to resume
      </p>
    </div>
  );
}

function formatMmSs(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
