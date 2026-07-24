import { Button } from '../ui/Button';
import type { UnlockAuditApi } from '../../hooks/use-unlock-audit';
import type { UnlockMethod } from '../../lib/unlock-audit';

const METHOD_LABEL: Record<UnlockMethod, string> = {
  passphrase: 'Passphrase',
  securityKey: 'Security key',
  remote: 'Remote approval',
};

// Shown right after a successful unlock when someone got the credential wrong
// since the last one. Deliberately a dialog rather than a toast: this is the
// one thing in the audit trail you must not scroll past. Every attempt is
// listed with its time and method, so an own typo two minutes ago is
// immediately distinguishable from a 03:00 attempt while you were asleep.
// Sits below the remote-approval and update prompts in the stack — those are
// time-critical, this one only has to be acknowledged.
export function UnlockAuditAlert({ alert, dismiss }: UnlockAuditApi) {
  if (!alert) return null;
  const { failed, previousUnlockAt } = alert;
  const count = failed.length;

  return (
    <div
      className="fixed inset-0 z-[280] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="unlock-audit-title"
    >
      <div className="w-full max-w-sm rounded-2xl border border-red-200 bg-white p-6 shadow-2xl dark:border-red-900/60 dark:bg-zinc-900">
        <div className="mb-2 flex items-center gap-2">
          <span aria-hidden className="text-xl">⚠️</span>
          <h2 id="unlock-audit-title" className="text-lg font-medium text-red-700 dark:text-red-300">
            {count === 1 ? 'A failed unlock attempt' : `${count} failed unlock attempts`}
          </h2>
        </div>
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          The wrong credential was entered on this device since your last unlock
          {previousUnlockAt ? ` (${new Date(previousUnlockAt).toLocaleString()})` : ''}. If that wasn’t you,
          treat this device as touched.
        </p>

        <ul className="mb-4 max-h-40 space-y-1 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-700 dark:bg-zinc-800/60">
          {failed.map((entry, i) => (
            <li key={`${entry.at}-${i}`} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-zinc-600 dark:text-zinc-300">{new Date(entry.at).toLocaleString()}</span>
              <span className="shrink-0 text-zinc-400">{METHOD_LABEL[entry.method] ?? entry.method}</span>
            </li>
          ))}
        </ul>

        <div className="flex justify-end">
          <Button
            onClick={dismiss}
            className="min-h-[44px] w-full px-4 text-base md:min-h-0 md:w-auto md:px-3 md:py-1.5 md:text-xs"
          >
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
