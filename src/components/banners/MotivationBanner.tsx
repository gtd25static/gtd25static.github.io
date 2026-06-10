import { useState } from 'react';
import { useMotivation } from '../../hooks/use-motivation';

/**
 * Motivational one-liner. Default: subtle row inside the TopBanner stack.
 * `prominent`: standout card used by the Focus view, where the message is part
 * of the daily commitment ritual rather than background noise.
 */
export function MotivationBanner({ prominent = false }: { prominent?: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  const motivation = useMotivation();

  if (dismissed || !motivation) return null;

  if (prominent) {
    return (
      <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-accent-200/70 bg-gradient-to-r from-accent-50 to-accent-100/50 px-5 py-4 dark:border-accent-800/40 dark:from-accent-950/40 dark:to-accent-900/20">
        <div className="flex items-center gap-3 min-w-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="shrink-0 text-accent-500 dark:text-accent-400">
            <path d="M12 2l1.8 5.6a1 1 0 00.6.6L20 10l-5.6 1.8a1 1 0 00-.6.6L12 18l-1.8-5.6a1 1 0 00-.6-.6L4 10l5.6-1.8a1 1 0 00.6-.6L12 2z" />
            <path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z" opacity="0.7" />
          </svg>
          <span className="text-base font-medium leading-snug text-accent-800 dark:text-accent-200">
            {motivation.text}
          </span>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-full p-1.5 text-accent-400 hover:bg-accent-100 hover:text-accent-600 dark:hover:bg-accent-900/40 dark:hover:text-accent-300"
          aria-label="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-1.5 md:py-1 dark:border-zinc-800">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        {motivation.text}
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="ml-2 shrink-0 rounded p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        aria-label="Dismiss"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </div>
  );
}
