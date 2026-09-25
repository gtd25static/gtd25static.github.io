import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RotationPhase, RotationProgress } from '../../sync/key-rotation';
import { touchVaultActivity } from '../../db/vault';

const STEPS: Array<{ phase: RotationPhase; label: string }> = [
  { phase: 'syncing', label: 'Syncing the latest changes' },
  { phase: 'files', label: 'Re-encrypting shared files' },
  { phase: 'snapshot', label: 'Rewriting your data under the new password' },
  { phase: 'backups', label: 'Rewriting the backups' },
  { phase: 'registry', label: 'Updating the device registry' },
  { phase: 'history', label: 'Compacting the repository history' },
];

// Re-arm the vault's idle lock well inside its shortest timeout (1 minute).
const KEEP_AWAKE_MS = 15_000;

/**
 * Takes over the screen while the sync password is being changed (the whole
 * repository is re-encrypted). It used to be one small status line under the
 * Save button, easy to miss while closing the window mid-way. Interrupting is
 * recoverable — saving the same new password again finishes the change — but
 * this makes it unlikely:
 *  - a modal <dialog> above everything, Settings included, that Escape can't
 *    dismiss and that has no close button: it goes when the rotation ends;
 *  - the browser asks before the page is closed or reloaded;
 *  - a Paranoid vault's idle auto-lock is held off meanwhile (a lock mid-way
 *    drops the credentials the rotation needs). Content stays covered by this
 *    dialog, and a manual lock or lock-when-hidden still lock as usual.
 */
export function RotationProgressDialog({ progress }: { progress: RotationProgress | null }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const running = progress !== null;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && running && !dialog.open) dialog.showModal();
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older Chromium needs it set to show the prompt
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    touchVaultActivity();
    const keepAwake = setInterval(touchVaultActivity, KEEP_AWAKE_MS);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      clearInterval(keepAwake);
    };
  }, [running]);

  if (!progress) return null;
  const current = STEPS.findIndex((s) => s.phase === progress.phase);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="rotation-progress-title"
      onCancel={(e) => e.preventDefault()}
      className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl backdrop:bg-black/60 dark:bg-zinc-900"
    >
      <h2 id="rotation-progress-title" className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
        Changing the sync password
      </h2>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
        Keep this window open, and don't lock the app, switch apps or turn the device off until this
        finishes — usually under a minute. Everything in your sync repository is being re-encrypted with
        the new password.
      </p>
      <ol className="mt-4 space-y-2" role="list">
        {STEPS.map((step, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'pending';
          const count = state === 'current' && step.phase === 'files' && progress.total
            ? ` ${Math.min((progress.done ?? 0) + 1, progress.total)}/${progress.total}`
            : '';
          return (
            <li key={step.phase} data-state={state} className="flex items-center gap-3 text-sm">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
                {state === 'done' && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-600">
                    <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {state === 'current' && (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent-500 border-t-transparent" />
                )}
                {state === 'pending' && <span className="h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-600" />}
              </span>
              <span className={state === 'pending' ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-100'}>
                {step.label}{count}
              </span>
            </li>
          );
        })}
      </ol>
    </dialog>
  );
}
