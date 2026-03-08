import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function Modal({ open, onClose, title, children }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

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
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
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
