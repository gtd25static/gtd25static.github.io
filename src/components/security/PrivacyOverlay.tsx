import { useCallback, useEffect, useRef, useState } from 'react';
import { getVaultIdleState, touchVaultActivity } from '../../db/vault';

// How often the countdown is checked. A poll (vs. a timer armed per-activity)
// needs no hook into every touchVaultActivity call site and self-corrects after
// background-tab timer throttling.
const POLL_MS = 2_000;
/** How much of the time still left before the auto-lock the veil waits out. */
const VEIL_AFTER_REMAINING_FRACTION = 0.5;

// Privacy veil for Paranoid Mode (opt-in): while the vault is unlocked, blur the
// whole app once it has been in the background (tab hidden, or window unfocused)
// for HALF the time that was still left before the auto-lock. A screen you walk
// away from stops being readable well before it locks, while an app you are
// merely looking at, or glanced away from for a moment, is never veiled.
//
// With `immediate` (the opt-in sub-setting) the veil raises on the way out
// instead. That is the only way to blank the task-switcher preview: mobile
// snapshots the app at the moment of backgrounding, long before any countdown
// could expire.
//
// Deterrence, not cryptography: the content is still in the DOM behind CSS.
// The auto-lock (which actually drops the DEK) is untouched underneath.
//
// Dismissing counts as vault activity (touchVaultActivity): a wake gesture is
// real interaction. pointermove is listened to ONLY while the veil is up, so it
// never becomes a general activity source and ACR-002 (only real interaction
// defers the lock) keeps its shape. Waking an unfocused-but-visible window that
// way restarts the countdown from that fresh activity — otherwise one stray
// mouse move would disable the veil until the window was focused again.
export function PrivacyOverlay({ immediate = false }: { immediate?: boolean }) {
  const [veiled, setVeiled] = useState(false);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const veiledRef = useRef(veiled);
  veiledRef.current = veiled;
  const immediateRef = useRef(immediate);
  immediateRef.current = immediate;
  /** When to raise the veil, or null when we are not counting down. */
  const veilAtRef = useRef<number | null>(null);
  const backgroundRef = useRef(false);

  const armCountdown = useCallback(() => {
    const { lastActivityAt, timeoutMs } = getVaultIdleState();
    const remaining = Math.max(0, lastActivityAt + timeoutMs - Date.now());
    veilAtRef.current = Date.now() + remaining * VEIL_AFTER_REMAINING_FRACTION;
  }, []);

  const enterBackground = useCallback(() => {
    backgroundRef.current = true;
    if (veiledRef.current || veilAtRef.current !== null) return; // already veiled/counting
    if (immediateRef.current) setVeiled(true);
    else armCountdown();
  }, [armCountdown]);

  // Raise: only from the background, and only once the countdown has run out.
  useEffect(() => {
    const returnToForeground = () => {
      backgroundRef.current = false;
      veilAtRef.current = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') enterBackground();
      else returnToForeground();
    };
    const poll = setInterval(() => {
      if (veiledRef.current || veilAtRef.current === null) return;
      if (Date.now() >= veilAtRef.current) setVeiled(true);
    }, POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', enterBackground);
    window.addEventListener('focus', returnToForeground);
    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', enterBackground);
      window.removeEventListener('focus', returnToForeground);
    };
  }, [enterBackground]);

  // Dismiss on any deliberate return: movement, press, key, focus, tab visible.
  useEffect(() => {
    if (!veiled) return;
    const dismiss = () => {
      touchVaultActivity();
      veiledRef.current = false;
      veilAtRef.current = null;
      setVeiled(false);
      // Still away? Count down again from the activity just recorded. Not in
      // immediate mode: there the veil belongs to the next backgrounding, and
      // re-raising it here would make it impossible to dismiss.
      if (backgroundRef.current && !immediateRef.current) armCountdown();
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
  }, [veiled, armCountdown]);

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
