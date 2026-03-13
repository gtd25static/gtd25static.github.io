import type { ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: string;
  count: number;
  children: ReactNode;
  onNext?: () => void;
  onPrev?: () => void;
  onSkip?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  nextLabel?: string;
}

export function ReviewStep({ title, subtitle, count, children, onNext, onPrev, onSkip, isFirst, isLast, nextLabel }: Props) {
  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium text-zinc-800 dark:text-zinc-200">
            {title}
            <span className="ml-2 inline-flex items-center justify-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {count}
            </span>
          </h3>
          {subtitle && <p className="text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
        </div>
      </div>

      {/* Scrollable item list */}
      <div className="max-h-[60vh] overflow-y-auto scrollbar-thin">
        {count === 0 ? (
          <div className="flex items-center justify-center py-8 text-sm text-zinc-400">
            Nothing to review here
          </div>
        ) : (
          children
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <div>
          {!isFirst && onPrev && (
            <button onClick={onPrev} className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">
              Previous
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onSkip && !isLast && (
            <button onClick={onSkip} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              Skip
            </button>
          )}
          {onNext && (
            <button onClick={onNext} className="rounded-lg bg-accent-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-700">
              {isLast ? 'Finish' : nextLabel ?? 'Next'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
