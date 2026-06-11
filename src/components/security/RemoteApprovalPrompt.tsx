import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { useRemoteApprovals } from '../../hooks/use-remote-unlock';

const COOLDOWN_SECONDS = 2;

// Attention-grabbing overlay (like the update prompt) shown on a trusted device
// when one of its managed Paranoid devices requests a remote unlock. The Approve
// button is disabled for a few seconds so the user reads the device name + code and
// can't reflexively approve a request they didn't initiate.
export function RemoteApprovalPrompt() {
  const { pending, approve, deny } = useRemoteApprovals();
  const [cooldown, setCooldown] = useState(COOLDOWN_SECONDS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pending) return;
    setCooldown(COOLDOWN_SECONDS);
    setBusy(false);
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [pending]);

  if (!pending) return null;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
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
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={deny}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Deny
          </button>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => { setBusy(true); await approve(); }}
            disabled={busy || cooldown > 0}
          >
            {busy ? 'Approving…' : cooldown > 0 ? `Approve (${cooldown})` : 'Approve unlock'}
          </Button>
        </div>
      </div>
    </div>
  );
}
