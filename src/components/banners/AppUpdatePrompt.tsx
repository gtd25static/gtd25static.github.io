import { useState, useEffect } from 'react';
import { onVersionIncompatible, offVersionIncompatible, onSyncSuccess, offSyncSuccess } from '../../sync/sync-engine';
import { useServiceWorker } from '../../hooks/use-service-worker';
import { GIT_COMMIT } from '../../lib/constants';
import { changelogFor, parseVersionInfo, type VersionInfo } from '../../lib/changelog';
import { Button } from '../ui/Button';

// App-wide update prompt. Rendered from the always-mounted App (inside
// ServiceWorkerProvider) so it appears over BOTH the unlocked app and the lock
// screen — letting a user stuck on a buggy locked build pull a fix without wiping.
//
// UX: a centered, overlaying DIALOG by default (to nudge updating); choosing
// "Later" dismisses the dialog and falls back to a thin top BANNER that stays
// available but unobtrusive.
export function AppUpdatePrompt() {
  const { needRefresh, applyUpdate, checkForUpdate, forceCheck } = useServiceWorker();
  const [syncIncompat, setSyncIncompat] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [info, setInfo] = useState<VersionInfo | null>(null);

  // Fetch the LIVE version.json (cache-busted, bypassing the SW) to show what the
  // pending update contains — for BOTH a detected new build and a sync-required
  // update. Best-effort: omitted if offline / not deployed yet.
  useEffect(() => {
    if (!needRefresh && !syncIncompat) return;
    let active = true;
    fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => { const v = parseVersionInfo(j); if (active && v) setInfo(v); })
      .catch(() => { /* changelog is optional */ });
    return () => { active = false; };
  }, [needRefresh, syncIncompat]);

  // A sync that reports an incompatible version means an update is required —
  // force an immediate SW check so the waiting build is detected and applyUpdate
  // (not a bare reload) can install it.
  useEffect(() => {
    const handler = () => { setSyncIncompat(true); forceCheck(); };
    onVersionIncompatible(handler);
    return () => offVersionIncompatible(handler);
  }, [forceCheck]);

  // Opportunistically check for a new build after each successful sync.
  useEffect(() => {
    onSyncSuccess(checkForUpdate);
    return () => offSyncSuccess(checkForUpdate);
  }, [checkForUpdate]);

  // When the (modal) update prompt is about to show, close any open native <dialog>
  // (Settings, Pomodoro settings, etc.). Those render in the browser's TOP LAYER —
  // above any z-index — so the prompt would otherwise be hidden behind them. Closing
  // fires each dialog's onClose, so React state stays consistent and they don't re-open.
  useEffect(() => {
    if ((needRefresh || syncIncompat) && !dismissed) {
      document.querySelectorAll('dialog[open]').forEach((d) => {
        try { (d as HTMLDialogElement).close(); } catch { /* ignore */ }
      });
    }
  }, [needRefresh, syncIncompat, dismissed]);

  const available = needRefresh || syncIncompat;
  if (!available) return null;

  const changes = info ? changelogFor(info, GIT_COMMIT) : [];
  const sameCommit = info?.commit === GIT_COMMIT;
  const sameCommitRefresh = needRefresh && !syncIncompat && sameCommit && changes.length === 0;
  const message = syncIncompat
    ? 'A newer version of GTD25 is required to sync.'
    : sameCommitRefresh
      ? 'A refreshed copy of this build is available.'
    : 'A new version of GTD25 is available.';

  const doUpdate = () => {
    if (updating) return;
    if (needRefresh) {
      setUpdating(true);
      applyUpdate(); // skipWaiting + single guarded reload
    } else {
      window.location.reload();
    }
  };

  if (!dismissed && !sameCommitRefresh) {
    return (
      <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
        <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-2 flex items-center gap-2">
            <span aria-hidden className="text-xl">⬆️</span>
            <h2 className="text-lg font-medium text-zinc-800 dark:text-zinc-100">
              {syncIncompat ? 'Update required' : 'Update available'}
            </h2>
          </div>
          <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
            {message} Updating takes a second and keeps all your data.
          </p>

          {info && (
            <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-700 dark:bg-zinc-800/60">
              <p className="mb-1 font-mono text-[11px] text-zinc-400">
                {sameCommit ? `Current commit ${GIT_COMMIT}` : `${GIT_COMMIT} → ${info.commit}`}
              </p>
              {changes.length > 0 ? (
                <ul className="max-h-40 space-y-0.5 overflow-auto">
                  {changes.map((c) => (
                    <li key={c.h} className="text-xs text-zinc-600 dark:text-zinc-300">
                      <span className="font-mono text-zinc-400">{c.h}</span> {c.s}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-zinc-600 dark:text-zinc-300">
                  {sameCommit ? 'No newer deployed commit was found.' : 'No changelog entries are available.'}
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              Later
            </button>
            <Button size="sm" onClick={doUpdate} disabled={updating}>
              {updating ? 'Updating…' : 'Update now'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Dismissed -> unobtrusive top banner that stays available.
  return (
    <div className="fixed inset-x-0 top-0 z-[300] flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-white">
      <span>{message}</span>
      <button
        type="button"
        onClick={doUpdate}
        disabled={updating}
        className="shrink-0 rounded-md bg-white/20 px-3 py-1 text-xs font-bold hover:bg-white/30 disabled:opacity-70"
      >
        {updating ? 'Updating…' : 'Update now'}
      </button>
    </div>
  );
}
