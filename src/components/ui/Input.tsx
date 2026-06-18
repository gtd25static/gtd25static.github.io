import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { openNativePicker } from '../../lib/native-picker';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

// Native controls whose dropdown picker we open on click (anywhere in the field).
const PICKER_TYPES = new Set(['date', 'datetime-local', 'time', 'month', 'week']);

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
      <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 0 1 0-1.186A10.004 10.004 0 0 1 10 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0 1 10 17c-4.257 0-7.893-2.66-9.336-6.41ZM14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" clipRule="evenodd" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z" clipRule="evenodd" />
      <path d="M10.748 13.93l2.523 2.523a9.987 9.987 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z" />
    </svg>
  );
}

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ label, className = '', id, type, disabled, onClick, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
    const [revealed, setRevealed] = useState(false);
    const isPassword = type === 'password';
    const isPicker = !!type && PICKER_TYPES.has(type);

    // ::-ms-reveal is Edge's built-in password eye — hidden so there aren't two toggles.
    const input = (
      <input
        ref={ref}
        id={inputId}
        type={isPassword && revealed ? 'text' : type}
        disabled={disabled}
        onClick={(e) => {
          onClick?.(e);
          // Click anywhere in a date/time field opens its native picker, not just the icon.
          if (isPicker) openNativePicker(e.currentTarget);
        }}
        className={`rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-base md:text-sm text-zinc-900
          placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500
          dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:[color-scheme:dark]
          ${isPassword ? 'w-full pr-9 [&::-ms-reveal]:hidden' : ''} ${className}`}
        {...props}
      />
    );

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-xs font-medium text-zinc-500 dark:text-zinc-300">
            {label}
          </label>
        )}
        {isPassword ? (
          <div className="relative">
            {input}
            <button
              type="button"
              disabled={disabled}
              aria-label={revealed ? 'Hide password' : 'Show password'}
              aria-pressed={revealed}
              onClick={() => setRevealed((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center px-2.5 text-zinc-400 hover:text-zinc-600
                disabled:pointer-events-none disabled:opacity-50 dark:text-zinc-500 dark:hover:text-zinc-300"
            >
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        ) : input}
      </div>
    );
  },
);

Input.displayName = 'Input';
