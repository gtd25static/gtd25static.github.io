import { useState, useEffect, useCallback, useRef } from 'react';

interface ToastData {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
  onUndo?: () => void;
  leaving?: boolean;
}

let addToastFn: ((message: string, type?: ToastData['type'], onUndo?: () => void) => void) | null = null;

export function toast(message: string, type: ToastData['type'] = 'info', onUndo?: () => void) {
  addToastFn?.(message, type, onUndo);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    // Start exit animation
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    // Remove after animation
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
  }, []);

  const addToast = useCallback((message: string, type: ToastData['type'] = 'info', onUndo?: () => void) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, type, onUndo }]);
    const duration = onUndo ? 4000 : 3000;
    setTimeout(() => dismiss(id), duration);
  }, [dismiss]);

  useEffect(() => {
    addToastFn = addToast;
    return () => { addToastFn = null; };
  }, [addToast]);

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
      <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
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
