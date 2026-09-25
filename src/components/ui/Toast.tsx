import { useState, useEffect, useCallback, useRef } from 'react';

interface ToastData {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
  onUndo?: () => void;
  leaving?: boolean;
}

type AddToast = (message: string, type?: ToastData['type'], onUndo?: () => void, durationMs?: number) => void;

let addToastFn: AddToast | null = null;

// A toast fired while no container is mounted waits, briefly, for the next one:
// the app shell is swapped out for a wait screen during a vault re-key, and the
// confirmation is fired right as it comes back. Anything older is dropped, so a
// message from before a lock never surfaces after the unlock.
const PENDING_TOAST_TTL_MS = 5_000;
let pendingToasts: Array<{ at: number; message: string; type: ToastData['type']; onUndo?: () => void; durationMs?: number }> = [];

/** `durationMs` overrides the message-length heuristic below (for undos that need a longer window). */
export function toast(message: string, type: ToastData['type'] = 'info', onUndo?: () => void, durationMs?: number) {
  if (addToastFn) addToastFn(message, type, onUndo, durationMs);
  else pendingToasts.push({ at: Date.now(), message, type, onUndo, durationMs });
}

// Longer messages linger longer: 3s for short toasts, scaling linearly to 6s at
// 10+ words. Undo toasts keep a 4s floor so the Undo stays clickable.
export function toastDurationMs(message: string, hasUndo = false): number {
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  const wordBased = 3000 + (Math.min(words, 10) / 10) * 3000;
  return hasUndo ? Math.max(wordBased, 4000) : wordBased;
}

// Native modal <dialog>s (Settings, confirm prompts, …) paint in the top layer,
// above any z-index. Promoting the toaster to a popover puts toasts in the same
// top layer so they stay visible above those dialogs — notably full-screen ones
// on mobile. Falls back to plain z-index where the Popover API is unavailable.
const MAX_VISIBLE = 3;

const SUPPORTS_POPOVER =
  typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const nextId = useRef(0);
  const toasterRef = useRef<HTMLDivElement>(null);

  // Kept in step synchronously (several toasts can fire before React re-renders),
  // so a repeat and the cap below see every toast already added.
  const live = useRef<ToastData[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const publish = useCallback((next: ToastData[]) => {
    live.current = next;
    setToasts(next);
  }, []);

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    // Start exit animation, then remove
    publish(live.current.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => publish(live.current.filter((t) => t.id !== id)), 300);
  }, [publish]);

  const addToast = useCallback<AddToast>((message, type = 'info', onUndo, durationMs) => {
    const ms = durationMs ?? toastDurationMs(message, !!onUndo);
    const arm = (id: number) => {
      clearTimeout(timers.current.get(id));
      timers.current.set(id, setTimeout(() => dismiss(id), ms));
    };
    // The same message already on screen just stays up longer (the review saw 14
    // identical ones stacked). Undo toasts never merge: each undoes something else.
    const same = !onUndo && live.current.find((t) => !t.leaving && !t.onUndo && t.message === message && t.type === type);
    if (same) { arm(same.id); return; }

    const id = nextId.current++;
    publish([...live.current, { id, message, type, onUndo }]);
    arm(id);
    // At most MAX_VISIBLE at once: the oldest make way.
    const showing = live.current.filter((t) => !t.leaving);
    for (const old of showing.slice(0, Math.max(0, showing.length - MAX_VISIBLE))) dismiss(old.id);
  }, [dismiss, publish]);

  useEffect(() => {
    addToastFn = addToast;
    const fresh = pendingToasts.filter((t) => Date.now() - t.at < PENDING_TOAST_TTL_MS);
    pendingToasts = [];
    for (const t of fresh) addToast(t.message, t.type, t.onUndo, t.durationMs);
    return () => { addToastFn = null; };
  }, [addToast]);

  // Keep the toaster in the top layer while toasts are visible, re-promoting on
  // change so it stays above any dialog opened since. No-op without popover support.
  useEffect(() => {
    const el = toasterRef.current;
    if (!el || typeof el.showPopover !== 'function' || !el.hasAttribute('popover')) return;
    try {
      if (toasts.length > 0) {
        if (el.matches(':popover-open')) el.hidePopover();
        el.showPopover();
      } else if (el.matches(':popover-open')) {
        el.hidePopover();
      }
    } catch {
      /* popover open/close can race during rapid updates — ignore */
    }
  }, [toasts]);

  const colors = {
    success: 'bg-green-600',
    error: 'bg-red-600',
    info: 'bg-accent-600',
  };

  return (
    <>
      <style>{`
        @keyframes toast-slide-in {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes toast-slide-out {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(50%); opacity: 0; }
        }
      `}</style>
      <div
        ref={toasterRef}
        data-toaster
        role="status"
        aria-live="polite"
        popover={SUPPORTS_POPOVER ? 'manual' : undefined}
        className="fixed top-auto left-auto bottom-24 right-4 z-[100] m-0 flex max-w-[calc(100vw-2rem)] flex-col gap-2 border-0 bg-transparent p-0 overflow-visible"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              animation: t.leaving
                ? 'toast-slide-out 300ms ease-in forwards'
                : 'toast-slide-in 300ms ease-out',
            }}
            className={`flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-lg ${colors[t.type]}`}
          >
            {/* Toast copy embeds list/task names ("Moved to «Work»"). */}
            <span data-redact>{t.message}</span>
            {t.onUndo && (
              <button
                onClick={() => {
                  t.onUndo!();
                  dismiss(t.id);
                }}
                className="rounded px-2 py-0.5 text-xs font-bold underline underline-offset-2 hover:bg-white/20"
              >
                Undo
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
