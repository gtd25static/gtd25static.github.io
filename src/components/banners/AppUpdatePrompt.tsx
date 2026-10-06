import { useState, useEffect } from 'react';
import { onVersionIncompatible, offVersionIncompatible, onSyncSuccess, offSyncSuccess } from '../../sync/sync-engine';
import { useServiceWorker } from '../../hooks/use-service-worker';
import { useVault } from '../../hooks/use-vault';
import { GIT_COMMIT } from '../../lib/constants';
import { changelogFor, fetchDeployedChanges, type VersionInfo } from '../../lib/changelog';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { forceServiceWorkerUpdate } from '../../lib/diagnostics';

const PARANOID_UPDATE_NOTICE_KEY = 'gtd25-paranoid-update-notice';
const PARANOID_UPDATE_NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_NOTICE_AUTO_DISMISS_MS = 5000;

type ParanoidUpdateNotice = {
  from: string;
  to?: string;
  at: number;
};

function readCompletedParanoidUpdateNotice(): boolean {
  const raw = localStorage.getItem(PARANOID_UPDATE_NOTICE_KEY);
  if (!raw) return false;

  let notice: Partial<ParanoidUpdateNotice>;
  try {
    notice = JSON.parse(raw) as Partial<ParanoidUpdateNotice>;
  } catch {
    localStorage.removeItem(PARANOID_UPDATE_NOTICE_KEY);
    return false;
  }

  if (typeof notice.from !== 'string' || typeof notice.at !== 'number') {
    localStorage.removeItem(PARANOID_UPDATE_NOTICE_KEY);
    return false;
  }

  if (Date.now() - notice.at > PARANOID_UPDATE_NOTICE_TTL_MS) {
    localStorage.removeItem(PARANOID_UPDATE_NOTICE_KEY);
    return false;
  }

  if (notice.from === GIT_COMMIT) return false;

  localStorage.removeItem(PARANOID_UPDATE_NOTICE_KEY);
  return true;
}

function armParanoidUpdateNotice(targetCommit?: string): void {
  const notice: ParanoidUpdateNotice = {
    from: GIT_COMMIT,
    to: targetCommit,
    at: Date.now(),
  };
  // Only a notice: with storage full it threw, and the update never ran (the
  // button stuck on "Updating…", or the error took the prompt down).
  try { localStorage.setItem(PARANOID_UPDATE_NOTICE_KEY, JSON.stringify(notice)); } catch { /* no notice, still updates */ }
}

// App-wide update prompt. Rendered from the always-mounted App (inside
// ServiceWorkerProvider) so it appears over BOTH the unlocked app and the lock
// screen — letting a user stuck on a buggy locked build pull a fix without wiping.
//
// UX: a centered, overlaying DIALOG by default (to nudge updating); choosing
// "Later" dismisses the dialog and falls back to a thin top BANNER that stays
// available but unobtrusive.
export function AppUpdatePrompt() {
  const { needRefresh, applyUpdate, checkForUpdate, forceCheck } = useServiceWorker();
  const vault = useVault();
  const [syncIncompat, setSyncIncompat] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [versionChecked, setVersionChecked] = useState(false);
  const [deferUntilLocked, setDeferUntilLocked] = useState(false);
  const [updateInstalledNoticeVisible, setUpdateInstalledNoticeVisible] = useState(() => readCompletedParanoidUpdateNotice());

  // Fetch the LIVE changes.json (cache-busted, bypassing the SW) to show what the
  // pending update contains — for BOTH a detected new build and a sync-required
  // update. Best-effort: omitted if offline / not deployed yet.
  useEffect(() => {
    setInfo(null);
    setVersionChecked(false);
    if (!needRefresh && !syncIncompat) return;
    let active = true;
    fetchDeployedChanges()
      .then((v) => { if (active && v) setInfo(v); }) // the changelog is optional
      .finally(() => { if (active) setVersionChecked(true); });
    return () => { active = false; };
  }, [needRefresh, syncIncompat]);

  // A sync that reports an incompatible version means an update is required —
  // force an immediate SW check so the waiting build is detected and applyUpdate
  // (not a bare reload) can install it.
  useEffect(() => {
    const handler = () => { setSyncIncompat(true); void forceCheck(); };
    onVersionIncompatible(handler);
    return () => offVersionIncompatible(handler);
  }, [forceCheck]);

  // Opportunistically check for a new build after each successful sync.
  useEffect(() => {
    onSyncSuccess(checkForUpdate);
    return () => offSyncSuccess(checkForUpdate);
  }, [checkForUpdate]);

  const changes = info ? changelogFor(info, GIT_COMMIT) : [];
  const sameCommit = info?.commit === GIT_COMMIT;
  const sameCommitRefresh = needRefresh && !syncIncompat && versionChecked && sameCommit && changes.length === 0;
  const waitingForVersionCheck = needRefresh && !syncIncompat && !versionChecked;
  const available = (needRefresh || syncIncompat) && !sameCommitRefresh;

  // Native <dialog>s (an edit form, Settings, a password prompt, the password
  // change's progress) use showModal(), whose top layer paints above any
  // z-index and would hide the prompt. The prompt used to close them — an Edit
  // Task dialog and its unsaved text included. Now, while one is open, the
  // prompt waits as the top banner and comes back as the dialog once it closes;
  // the observer also catches dialogs that open after it (a focus nudge).
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => {
    if (!available) return;
    const check = () => setDialogOpen(!!document.querySelector('dialog[open]'));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, [available]);

  // Over a locked vault it is the top banner, never the modal: the modal sat
  // above the lock screen and looked the same whether the vault had locked under
  // it or not (a Mac woken after hours showed it over a vault it had left open).
  const asModal = !dismissed && !vault.locked && !dialogOpen;

  useEffect(() => {
    if (deferUntilLocked && vault.locked && !updating) {
      setUpdating(true);
      armParanoidUpdateNotice(info?.commit);
      if (needRefresh) applyUpdate();
      else window.location.reload();
    }
  }, [applyUpdate, deferUntilLocked, info?.commit, needRefresh, updating, vault.locked]);

  // The post-update green notice auto-dismisses after a few seconds; the Dismiss
  // button's fill animation visualizes the same countdown. This timer is the
  // authoritative dismissal (robust even if the CSS animation is suppressed).
  useEffect(() => {
    if (!updateInstalledNoticeVisible) return;
    const timer = setTimeout(() => setUpdateInstalledNoticeVisible(false), UPDATE_NOTICE_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [updateInstalledNoticeVisible]);

  if (updateInstalledNoticeVisible) {
    return (
      <>
        <style>{`
          @keyframes update-notice-fill {
            from { width: 0%; }
            to { width: 100%; }
          }
        `}</style>
        <div className="fixed inset-x-0 top-0 z-[300] flex items-center justify-between gap-3 bg-green-600 px-4 py-2 text-sm font-medium text-white">
          <span>GTD25 updated. Your Paranoid vault is locked for safety.</span>
          <button
            type="button"
            onClick={() => setUpdateInstalledNoticeVisible(false)}
            className="relative shrink-0 overflow-hidden rounded-md bg-white/20 px-3 py-1 text-xs font-bold hover:bg-white/30"
          >
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 bg-white/40"
              style={{ animation: `update-notice-fill ${UPDATE_NOTICE_AUTO_DISMISS_MS}ms linear forwards` }}
            />
            <span className="relative">Dismiss</span>
          </button>
        </div>
      </>
    );
  }
  if (!available || waitingForVersionCheck) return null;

  const message = deferUntilLocked
    ? 'Update queued. It will install after the vault locks.'
    : syncIncompat
      ? 'A newer version of GTD25 is required to sync.'
      : 'A new version of GTD25 is available.';
  const deferUpdate = vault.enabled && vault.unlocked && (needRefresh || syncIncompat);

  const doUpdate = () => {
    if (updating) return;
    if (deferUpdate) {
      setDeferUntilLocked(true);
      setDismissed(true);
      return;
    }
    if (needRefresh) {
      setUpdating(true);
      if (vault.enabled) armParanoidUpdateNotice(info?.commit);
      applyUpdate(); // skipWaiting + single guarded reload
    } else {
      // Required by sync, but no new build waiting: a bare reload re-ran this
      // one. Look for it — found, it waits and this prompt applies it.
      setUpdating(true);
      void forceCheck().then(async (result) => {
        setUpdating(false);
        if (result === 'update-found') return;
        if (result === 'stale-worker') {
          if (vault.enabled) armParanoidUpdateNotice(info?.commit);
          if ((await forceServiceWorkerUpdate()) !== 'offline') return;
        }
        toast(result === 'up-to-date'
          ? 'No newer version is published yet. Try again in a few minutes.'
          : "Couldn't check for the update. Check the connection and try again.", 'error');
      });
    }
  };

  if (asModal) {
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
              {updating ? 'Updating…' : deferUpdate ? 'Update when locked' : 'Update now'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Dismissed, or the vault is locked -> unobtrusive top banner that stays available.
  return (
    <div className="fixed inset-x-0 top-0 z-[300] flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-white">
      <span>{message}</span>
      <button
        type="button"
        onClick={doUpdate}
        disabled={updating}
        className="shrink-0 rounded-md bg-white/20 px-3 py-1 text-xs font-bold hover:bg-white/30 disabled:opacity-70"
      >
        {updating ? 'Updating…' : deferUpdate ? 'Update when locked' : 'Update now'}
      </button>
    </div>
  );
}
