import { useState, useEffect } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { RandomizedKeyboard } from './RandomizedKeyboard';
import { unlockWithPassphrase, unlockWithSecurityKey, refreshSecurityKeyFlag } from '../../db/vault';
import { useVault } from '../../hooks/use-vault';
import { useLockScreenRemote } from '../../hooks/use-remote-unlock';
import { useServiceWorker } from '../../hooks/use-service-worker';
import { panicWipe } from '../../lib/panic-wipe';
import { PomodoroBar } from '../pomodoro/PomodoroBar';

// Full-screen gate shown when Paranoid Mode is enabled but the vault is locked.
// Until the passphrase or security key unlocks the DEK, no decrypted data is
// rendered — the rest of the app is not even mounted.
//
// Unlock strategy: the security key (when enrolled) is the primary, keylogger-
// safe path — nothing is typed. The passphrase is the fallback, a normal typed
// field by default (practical), with an OPT-IN randomized on-screen keyboard for
// the rare time you must enter it on an untrusted machine without it being keyed.
export function LockScreen() {
  const { hasSecurityKey } = useVault();
  const remote = useLockScreenRemote();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showWipe, setShowWipe] = useState(false);
  const [attempt, setAttempt] = useState(0);       // bump to reshuffle the on-screen keys
  const [onScreen, setOnScreen] = useState(false); // opt-in keylogger-safe entry
  const [showPass, setShowPass] = useState(false); // passphrase is a hidden last resort
  const { forceCheck } = useServiceWorker();
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // Self-heal the security-key affordance from authoritative vault metadata, so a
  // cleared/tampered localStorage cache can't hide the hardware-key unlock path and
  // push the user toward typing the passphrase on an untrusted device (ACR-012).
  useEffect(() => { void refreshSecurityKeyFlag(); }, []);

  function handleCheckUpdate() {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    forceCheck(); // if a new build exists, AppUpdatePrompt shows the dialog over this screen
    setTimeout(() => setCheckingUpdate(false), 5000);
  }

  async function handleUnlock() {
    if (!passphrase || busy) return;
    setBusy(true);
    setError('');
    try {
      const ok = await unlockWithPassphrase(passphrase);
      if (!ok) {
        setError('Incorrect passphrase');
        setPassphrase('');
        setAttempt((n) => n + 1);
      }
      // On success the vault emits -> the app re-renders and unmounts this screen.
    } catch {
      setError('Could not unlock the vault');
    } finally {
      setBusy(false);
    }
  }

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    void handleUnlock();
  }

  async function handleSecurityKey() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const ok = await unlockWithSecurityKey();
      if (!ok) setError('Security key unlock failed. Use your passphrase.');
    } catch {
      setError('Security key unlock failed. Use your passphrase.');
    } finally {
      setBusy(false);
    }
  }

  // Escape hatch when the passphrase is lost: a full panic wipe (IndexedDB,
  // localStorage, caches, service worker). Synced data on other devices survives.
  async function handleWipe() {
    await panicWipe();
  }

  // A safer unlock method exists -> the passphrase becomes a hidden last resort.
  const hasOtherMethod = hasSecurityKey || remote.enrolled;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-100 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex items-center gap-2">
          <span aria-hidden className="text-xl">🔒</span>
          <h1 className="text-lg font-medium text-zinc-800 dark:text-zinc-100">Vault locked</h1>
        </div>

        {hasSecurityKey && (
          <div className="mb-4">
            <Button type="button" onClick={handleSecurityKey} disabled={busy}>
              🔑 {busy ? 'Unlocking…' : 'Unlock with security key or phone'}
            </Button>
          </div>
        )}

        {remote.enrolled && (
          <div className="mb-4 space-y-2">
            {remote.code ? (
              <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Approve on a trusted device. Confirm this code matches the one shown there:
                </p>
                <p className="my-1 text-center text-2xl font-semibold tracking-[0.3em] text-zinc-800 dark:text-zinc-100">
                  {remote.code}
                </p>
                <div className="text-center">
                  <button type="button" onClick={remote.cancel} className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                    Cancel request
                  </button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="secondary" onClick={() => void remote.request()}>
                📲 Request unlock from a trusted device
              </Button>
            )}
            {remote.error && <p className="text-sm text-red-600 dark:text-red-400">{remote.error}</p>}
          </div>
        )}

        {/* Passphrase is a LAST RESORT in Paranoid Mode: typing it on an untrusted
            machine can expose it. Hide it behind a disclosure whenever a safer method
            (security key / trusted device) is available; show it directly only when it
            is the sole way in. */}
        {(!hasOtherMethod || showPass) ? (
          <>
            {hasOtherMethod && (
              <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
                Last resort. Typing your passphrase on an untrusted device can expose it — prefer your
                security key or a trusted device. Rotate it afterward if this machine isn't trusted.
              </p>
            )}
            {onScreen ? (
              <>
                <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                  Tap your passphrase on the on-screen keys — never typed, so a keylogger sees nothing.
                </p>
                <RandomizedKeyboard
                  value={passphrase}
                  onChange={setPassphrase}
                  onSubmit={handleUnlock}
                  disabled={busy}
                  nonce={attempt}
                  submitLabel={busy ? 'Unlocking…' : 'Unlock'}
                />
              </>
            ) : (
              <form onSubmit={handleFormSubmit}>
                <Input
                  label="Passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter vault passphrase"
                  autoFocus={!hasOtherMethod}
                  disabled={busy}
                />
                <div className="mt-3">
                  <Button type="submit" disabled={busy || !passphrase}>
                    {busy ? 'Unlocking…' : 'Unlock'}
                  </Button>
                </div>
              </form>
            )}

            {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={() => { setOnScreen((v) => !v); setPassphrase(''); setError(''); }}
                disabled={busy}
                className="text-xs text-zinc-500 underline-offset-2 hover:underline disabled:opacity-50 dark:text-zinc-400"
              >
                {onScreen ? '⌨︎ Use keyboard input' : '🔒 Use on-screen keyboard (keylogger-safe)'}
              </button>
            </div>
          </>
        ) : (
          <div className="mt-2 text-center">
            {error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button
              type="button"
              onClick={() => { setShowPass(true); setError(''); }}
              disabled={busy}
              className="text-xs text-zinc-400 underline-offset-2 hover:text-zinc-600 hover:underline disabled:opacity-50 dark:text-zinc-500 dark:hover:text-zinc-300"
            >
              Enter passphrase instead (last resort)
            </button>
          </div>
        )}

        {/* Pomodoro controls — task-data-free, so safe while locked. The settings
            gear is hidden here (settings are not available while locked). */}
        <div className="mt-6 flex justify-center border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <PomodoroBar hideSettings />
        </div>

        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={handleCheckUpdate}
            disabled={checkingUpdate}
            className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-50 dark:hover:text-zinc-300"
          >
            {checkingUpdate ? 'Checking for updates…' : 'Check for app updates'}
          </button>
        </div>

        <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          {showWipe ? (
            <div className="space-y-2">
              <p className="text-xs text-red-600 dark:text-red-400">
                This erases all local data on this device. Data synced to other devices is not
                affected. This cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleWipe}
                  className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                >
                  Confirm wipe
                </button>
                <button
                  type="button"
                  onClick={() => setShowWipe(false)}
                  className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowWipe(true)}
              className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              Forgot your passphrase? Wipe this device
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
