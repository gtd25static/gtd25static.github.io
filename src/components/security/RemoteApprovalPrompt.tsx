import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { useRemoteApprovals } from '../../hooks/use-remote-unlock';
import { DENIAL_PAUSE_MS } from '../../sync/remote-unlock';

const COOLDOWN_SECONDS = 2;

const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Attention-grabbing overlay (like the update prompt) shown on a trusted device
// when one of its managed Paranoid devices requests a remote unlock. The Approve
// button is disabled for a few seconds so the user reads the device name + code and
// can't reflexively approve a request they didn't initiate. Above the update
// prompt (which also waits while a request is on screen, lib/approval-gate).
//
// A request from a device declined a moment ago is held back: a line at the
// bottom instead of the overlay, so a stream of unwanted requests cannot wear
// you down, while a real one is one tap away.
export function RemoteApprovalPrompt() {
  const { pending, held, approve, deny, showHeld, ignoreHeld } = useRemoteApprovals();
  const [cooldown, setCooldown] = useState(COOLDOWN_SECONDS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pending) return;
    setCooldown(COOLDOWN_SECONDS);
    setBusy(false);
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [pending]);

  if (!pending && held) {
    return (
      <div
        role="status"
        className="fixed inset-x-0 bottom-0 z-[310] flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <div className="flex w-full max-w-md flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-lg dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <p className="min-w-0 flex-1">
            <span className="font-medium">“{held.fromName}”</span> is asking to unlock. Held back: you declined a
            request from it at {clock(held.heldUntil - DENIAL_PAUSE_MS)}.
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={ignoreHeld}
              className="min-h-[44px] rounded-lg px-3 text-amber-800 hover:bg-amber-100 md:min-h-0 md:py-1 dark:text-amber-200 dark:hover:bg-amber-900"
            >
              Ignore
            </button>
            <button
              type="button"
              onClick={showHeld}
              className="min-h-[44px] rounded-lg bg-amber-600 px-3 font-medium text-white hover:bg-amber-700 md:min-h-0 md:py-1"
            >
              Show request
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!pending) return null;

  return (
    <div className="fixed inset-0 z-[310] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-2 flex items-center gap-2">
          <span aria-hidden className="text-xl">🔓</span>
          <h2 className="text-lg font-medium text-zinc-800 dark:text-zinc-100">Remote unlock requested</h2>
        </div>
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-700 dark:text-zinc-200">“{pending.fromName}”</span> is asking to
          unlock. Approve <span className="font-semibold">only</span> if you started it and the code below matches the
          one shown on that device.
        </p>
        <div className="my-4 rounded-lg border border-zinc-200 bg-zinc-50 py-3 dark:border-zinc-700 dark:bg-zinc-800/60">
          <p className="text-center text-3xl font-semibold tracking-[0.3em] text-zinc-800 dark:text-zinc-100">
            {pending.code}
          </p>
        </div>
        {/* Comfortable thumb targets: this dialog is answered on a phone, often
            in a hurry. Both actions are ≥44px tall and share the row on mobile,
            shrinking to the usual dialog-sized buttons from md up. */}
        <div className="flex items-stretch justify-end gap-3">
          <button
            type="button"
            onClick={deny}
            disabled={busy}
            className="min-h-[44px] flex-1 rounded-xl border border-zinc-200 px-4 text-base text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 md:min-h-0 md:flex-none md:rounded-lg md:border-0 md:py-1.5 md:text-sm dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Deny
          </button>
          <Button
            variant="danger"
            onClick={async () => { setBusy(true); await approve(); }}
            disabled={busy || cooldown > 0}
            className="min-h-[44px] flex-1 px-4 text-base md:min-h-0 md:flex-none md:px-3 md:py-1.5 md:text-xs"
          >
            {busy ? 'Approving…' : cooldown > 0 ? `Approve (${cooldown})` : 'Approve unlock'}
          </Button>
        </div>
      </div>
    </div>
  );
}
