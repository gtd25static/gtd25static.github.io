import { useState, useEffect } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { db } from '../../db';
import { deriveKey, generateSalt, checkVerifier, cacheEncryptionKey } from '../../sync/crypto';
import { getFile } from '../../sync/github-api';
import { onEncryptionPasswordNeeded, offEncryptionPasswordNeeded, syncNow } from '../../sync/sync-engine';

export function EncryptionPasswordModal() {
  // null = closed, '' = new password needed, 'salt...' = existing encryption
  const [salt, setSalt] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const isNewPassword = salt === '';

  useEffect(() => {
    const handler = (s: string) => setSalt(s);
    onEncryptionPasswordNeeded(handler);
    return () => offEncryptionPasswordNeeded(handler);
  }, []);

  if (salt === null) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password.trim()) return;

    setLoading(true);
    setError('');

    try {
      if (isNewPassword) {
        // Confirm password match
        if (password !== confirmPassword) {
          setError('Passwords do not match');
          setLoading(false);
          return;
        }
        // Setting up encryption for the first time
        const newSalt = generateSalt();
        const key = await deriveKey(password, newSalt);
        cacheEncryptionKey(key, newSalt);

        // Save password
        await db.localSettings.update('local', { encryptionPassword: password });

        // Close modal and retry sync
        setSalt(null);
        setPassword('');
        setConfirmPassword('');
        setError('');
        syncNow();
      } else {
        // Unlocking existing encryption
        const key = await deriveKey(password, salt!);

        // Verify against remote
        const local = await db.localSettings.get('local');
        if (!local?.githubPat || !local?.githubRepo) {
          setError('Sync not configured');
          return;
        }

        const file = await getFile(local.githubPat, local.githubRepo, 'gtd25-snapshot.json');
        if (!file) {
          setError('Could not fetch remote data');
          return;
        }

        const snapshot = JSON.parse(file.data);
        const verifier = snapshot.encryptionVerifier;

        if (!verifier) {
          setError('Remote data has no verifier');
          return;
        }

        const ok = await checkVerifier(key, verifier);
        if (!ok) {
          setError('Incorrect password');
          return;
        }

        // Success — cache key
        cacheEncryptionKey(key, salt!);

        // Save password if requested
        if (rememberPassword) {
          await db.localSettings.update('local', { encryptionPassword: password });
        }

        // Close modal and retry sync
        setSalt(null);
        setPassword('');
        setConfirmPassword('');
        setError('');
        syncNow();
      }
    } catch {
      setError('Failed to verify password');
    } finally {
      setLoading(false);
    }
  }

  return (
    <dialog
      open
      className="fixed inset-0 z-[100] m-auto flex h-screen w-screen items-center justify-center bg-black/30 p-0"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <h2 className="mb-1 text-lg font-medium text-zinc-800 dark:text-zinc-200">
          {isNewPassword ? 'Set Encryption Password' : 'Encryption Password Required'}
        </h2>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          {isNewPassword
            ? 'All synced data is encrypted. Set a password to protect your data. All devices must use the same password.'
            : 'Your synced data is encrypted. Enter the password to decrypt it.'}
        </p>

        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={isNewPassword ? 'Choose a strong password' : 'Enter encryption password'}
          autoFocus
          disabled={loading}
        />

        {isNewPassword && (
          <div className="mt-2">
            <Input
              label="Confirm Password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password"
              disabled={loading}
            />
          </div>
        )}

        {error && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {!isNewPassword && (
          <label className="mt-3 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={rememberPassword}
              onChange={(e) => setRememberPassword(e.target.checked)}
              className="rounded border-zinc-300 dark:border-zinc-600"
              disabled={loading}
            />
            Remember password on this device
          </label>
        )}

        <div className="mt-4 flex gap-2">
          <Button size="sm" type="submit" disabled={loading || !password.trim() || (isNewPassword && !confirmPassword.trim())}>
            {loading ? 'Verifying...' : isNewPassword ? 'Set Password' : 'Unlock'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
