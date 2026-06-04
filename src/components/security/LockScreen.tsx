import { useState } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { unlockWithPassphrase } from '../../db/vault';
import { db } from '../../db';

// Full-screen gate shown when Paranoid Mode is enabled but the vault is locked.
// Until the passphrase (or, in PR3, biometric) unlocks the DEK, no decrypted data
// is rendered — the rest of the app is not even mounted.
export function LockScreen() {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showWipe, setShowWipe] = useState(false);

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const ok = await unlockWithPassphrase(passphrase);
      if (!ok) {
        setError('Incorrect passphrase');
        setPassphrase('');
      }
      // On success the vault emits -> the app re-renders and unmounts this screen.
    } catch {
      setError('Could not unlock the vault');
    } finally {
      setBusy(false);
    }
  }

  // Escape hatch when the passphrase is lost. PR4 replaces this with a full
  // panic wipe (caches + service worker). Synced data on other devices survives.
  async function handleWipe() {
    db.close();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('gtd25');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    for (const key of Object.keys(localStorage).filter((k) => k.startsWith('gtd25-'))) {
      localStorage.removeItem(key);
    }
    window.location.reload();
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-100 p-4 dark:bg-zinc-950">
      <form
        onSubmit={handleUnlock}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="mb-4 flex items-center gap-2">
          <span aria-hidden className="text-xl">🔒</span>
          <h1 className="text-lg font-medium text-zinc-800 dark:text-zinc-100">Vault locked</h1>
        </div>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Paranoid Mode is on. Enter your passphrase to decrypt this device&rsquo;s data.
        </p>

        <Input
          label="Passphrase"
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Enter vault passphrase"
          autoFocus
          disabled={busy}
        />

        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-4">
          <Button type="submit" disabled={busy || !passphrase.trim()}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
        </div>

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
      </form>
    </div>
  );
}
