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

/** `durationMs` overrides the message-length heuristic below (for undos that need a longer window). */
export function toast(message: string, type: ToastData['type'] = 'info', onUndo?: () => void, durationMs?: number) {
  addToastFn?.(message, type, onUndo, durationMs);
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
const SUPPORTS_POPOVER =
  typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const nextId = useRef(0);
  const toasterRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback((id: number) => {
    // Start exit animation
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    // Remove after animation
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
  }, []);

  const addToast = useCallback<AddToast>((message, type = 'info', onUndo, durationMs) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, type, onUndo }]);
    setTimeout(() => dismiss(id), durationMs ?? toastDurationMs(message, !!onUndo));
  }, [dismiss]);

  useEffect(() => {
    addToastFn = addToast;
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
        role="status"
        aria-live="polite"
        popover={SUPPORTS_POPOVER ? 'manual' : undefined}
        className="fixed top-auto left-auto bottom-4 right-4 z-[100] m-0 flex max-w-[calc(100vw-2rem)] flex-col gap-2 border-0 bg-transparent p-0 overflow-visible"
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
            {t.message}
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
