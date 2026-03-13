import { useState } from 'react';
import { useMotivation } from '../../hooks/use-motivation';

export function MotivationBanner() {
  const [dismissed, setDismissed] = useState(false);
  const motivation = useMotivation();

  if (dismissed || !motivation) return null;

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
