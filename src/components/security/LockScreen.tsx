import { useState } from 'react';
import { RandomizedKeyboard } from './RandomizedKeyboard';
import { unlockWithPassphrase, unlockWithSecurityKey } from '../../db/vault';
import { useVault } from '../../hooks/use-vault';
import { panicWipe } from '../../lib/panic-wipe';

// Full-screen gate shown when Paranoid Mode is enabled but the vault is locked.
// Until the passphrase (or security key) unlocks the DEK, no decrypted data
// is rendered — the rest of the app is not even mounted. The passphrase is
// entered on a randomized on-screen keyboard (never typed) to defeat keyloggers.
export function LockScreen() {
  const { hasSecurityKey } = useVault();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showWipe, setShowWipe] = useState(false);
  const [attempt, setAttempt] = useState(0); // bump to reshuffle the keyboard

  async function handleUnlock() {
    if (!passphrase || busy) return;
    setBusy(true);
    setError('');
    try {
      const ok = await unlockWithPassphrase(passphrase);
      if (!ok) {
        setError('Incorrect passphrase');
        setPassphrase('');
        setAttempt((n) => n + 1); // reshuffle the keys after a wrong attempt
      }
      // On success the vault emits -> the app re-renders and unmounts this screen.
    } catch {
      setError('Could not unlock the vault');
    } finally {
      setBusy(false);
    }
  }

  async function handleSecurityKey() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const ok = await unlockWithSecurityKey();
      // On success the vault emits -> the app re-renders and unmounts this screen.
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

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-100 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex items-center gap-2">
          <span aria-hidden className="text-xl">🔒</span>
          <h1 className="text-lg font-medium text-zinc-800 dark:text-zinc-100">Vault locked</h1>
        </div>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Paranoid Mode is on. Tap your passphrase on the on-screen keys (it is never typed, so a
          keylogger sees nothing).
        </p>

        <RandomizedKeyboard
          value={passphrase}
          onChange={setPassphrase}
          onSubmit={handleUnlock}
          disabled={busy}
          nonce={attempt}
          submitLabel={busy ? 'Unlocking…' : 'Unlock'}
        />

        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

        {hasSecurityKey && (
          <div className="mt-3 text-center">
            <button
              type="button"
              onClick={handleSecurityKey}
              disabled={busy}
              className="text-xs text-zinc-500 underline-offset-2 hover:underline disabled:opacity-50 dark:text-zinc-400"
            >
              🔑 Use security key instead
            </button>
          </div>
        )}

        <div className="mt-6 border-t border-zinc-200 pt-3 dark:border-zinc-800">
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
