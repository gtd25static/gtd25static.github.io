import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function Modal({ open, onClose, title, children }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mouseDownTarget = useRef<EventTarget | null>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={(e) => {
        // Prevent Escape from closing the dialog when a native date picker is open.
        // The date picker popup consumes Escape to close itself, but some browsers
        // also fire a cancel event on the dialog.
        e.preventDefault();
        const active = document.activeElement;
        const isNativePicker = active instanceof HTMLInputElement &&
          ['date', 'datetime-local', 'time'].includes(active.type);
        if (!isNativePicker) onClose();
      }}
      onMouseDown={(e) => {
        mouseDownTarget.current = e.target;
      }}
      onClick={(e) => {
        // Only close on backdrop click if BOTH mousedown and click originated on the
        // dialog backdrop itself. This prevents the native date picker popup (rendered
        // outside the dialog DOM) from triggering a close when its events bubble up.
        if (e.target === dialogRef.current && mouseDownTarget.current === dialogRef.current) {
          onClose();
        }
        mouseDownTarget.current = null;
      }}
      className="m-auto w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-0 shadow-2xl backdrop:bg-black/30
        dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
    >
      <div className="flex items-center justify-between px-6 py-4">
        <h2 className="text-lg font-normal text-zinc-800 dark:text-zinc-200">{title}</h2>
        <button
          onClick={onClose}
          className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          aria-label="Close"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 5l8 8M13 5l-8 8" />
          </svg>
        </button>
      </div>
      <div className="px-6 pb-6">{children}</div>
    </dialog>
  );
}
