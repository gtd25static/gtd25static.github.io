import { useMemo } from 'react';
import { Button } from '../ui/Button';

// On-screen keyboard whose key positions are RESHUFFLED on every mount / attempt.
// The passphrase is entered by clicking, never typed — so a keylogger captures
// nothing, and (since the screen is assumed not recorded) mouse-click coordinates
// map to no known key. There is intentionally no physical-keyboard input here.

const KEY_CHARS: string[] = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...'!@#$%^&*()-_=+[]{};:\'",.<>/?\\|`~',
];

function secureShuffle(arr: string[]): string[] {
  const a = arr.slice();
  const rnd = crypto.getRandomValues(new Uint32Array(a.length));
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function RandomizedKeyboard({
  value,
  onChange,
  onSubmit,
  disabled,
  nonce = 0,
  submitLabel = 'Unlock',
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  nonce?: number;        // bump to reshuffle (e.g. after a failed attempt)
  submitLabel?: string;
}) {
  // Reshuffle whenever the nonce changes (new lock screen / failed attempt).
  const layout = useMemo(() => secureShuffle(KEY_CHARS), [nonce]);

  return (
    <div className="space-y-2">
      {/* Masked length-only display (no plaintext echo). */}
      <div
        aria-label="Passphrase entry"
        className="flex min-h-[2.25rem] flex-wrap items-center gap-1 rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800"
      >
        {value.length === 0 ? (
          <span className="text-xs text-zinc-400">Tap keys to enter your passphrase</span>
        ) : (
          Array.from(value).map((_, i) => (
            <span key={i} className="h-2 w-2 rounded-full bg-zinc-500 dark:bg-zinc-300" />
          ))
        )}
      </div>

      <div className="grid grid-cols-10 gap-1">
        {layout.map((ch) => (
          <button
            key={ch}
            type="button"
            aria-label={ch}
            disabled={disabled}
            onClick={() => onChange(value + ch)}
            className="rounded bg-zinc-100 py-1.5 text-sm tabular-nums text-zinc-800 hover:bg-zinc-200 active:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
          >
            {ch}
          </button>
        ))}
      </div>

      <div className="flex gap-1">
        <button
          type="button"
          aria-label="Space"
          disabled={disabled}
          onClick={() => onChange(`${value} `)}
          className="flex-1 rounded bg-zinc-100 py-1.5 text-xs text-zinc-600 hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
        >
          Space
        </button>
        <button
          type="button"
          aria-label="Backspace"
          disabled={disabled || value.length === 0}
          onClick={() => onChange(value.slice(0, -1))}
          className="rounded bg-zinc-100 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
        >
          ⌫
        </button>
        <button
          type="button"
          aria-label="Clear"
          disabled={disabled || value.length === 0}
          onClick={() => onChange('')}
          className="rounded bg-zinc-100 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
        >
          Clear
        </button>
      </div>

      <Button type="button" onClick={onSubmit} disabled={disabled || value.length === 0}>
        {submitLabel}
      </Button>
    </div>
  );
}
