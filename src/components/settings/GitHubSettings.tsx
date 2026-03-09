import { useState, useEffect } from 'react';
import { useLocalSettings, updateLocalSettings } from '../../hooks/use-settings';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { testConnection } from '../../sync/github-api';
import { syncNow, forcePush, forcePull, wipeAllData } from '../../sync/sync-engine';
import { deriveKey, cacheEncryptionKey, generateSalt } from '../../sync/crypto';

export function GitHubSettings() {
  const local = useLocalSettings();
  const [pat, setPat] = useState('');
  const [repo, setRepo] = useState('');
  const [encPassword, setEncPassword] = useState('');
  const [encPasswordConfirm, setEncPasswordConfirm] = useState('');
  const [testing, setTesting] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Sync local state when Dexie data loads
  useEffect(() => {
    if (!initialized && local.githubPat !== undefined) {
      setPat(local.githubPat ?? '');
      setRepo(local.githubRepo ?? '');
      setEncPassword(local.encryptionPassword ?? '');
      setInitialized(true);
    }
  }, [local.githubPat, local.githubRepo, local.encryptionPassword, initialized]);

  async function handleSave() {
    const passwordChanged = encPassword.trim() !== (local.encryptionPassword ?? '');

    // Require confirmation when setting/changing password
    if (passwordChanged && encPassword.trim()) {
      if (encPassword !== encPasswordConfirm) {
        toast('Passwords do not match', 'error');
        return;
      }
      const salt = generateSalt();
      const key = await deriveKey(encPassword.trim(), salt);
      cacheEncryptionKey(key, salt);
    }

    await updateLocalSettings({
      githubPat: pat.trim() || undefined,
      githubRepo: repo.trim() || undefined,
      syncEnabled: !!(pat.trim() && repo.trim()),
      encryptionPassword: encPassword.trim() || undefined,
    });
    toast('Sync settings saved', 'success');

    // Password change requires re-encrypting all remote data with new key.
    // Force push overwrites remote with local data encrypted using the new key.
    if (passwordChanged && encPassword.trim() && pat.trim() && repo.trim()) {
      forcePush();
    }
  }

  async function handleTest() {
    if (!pat.trim() || !repo.trim()) {
      toast('Enter PAT and repo first', 'error');
      return;
    }
    setTesting(true);
    try {
      const ok = await testConnection(pat.trim(), repo.trim());
      toast(ok ? 'Connection successful!' : 'Connection failed', ok ? 'success' : 'error');
    } catch {
      toast('Connection failed', 'error');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">GitHub Sync</h3>
      <Input
        label="Personal Access Token"
        type="password"
        value={pat}
        onChange={(e) => setPat(e.target.value)}
        placeholder="ghp_..."
      />
      <Input
        label="Repository (owner/name)"
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
        placeholder="username/gtd25-data"
      />
      <div className="border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <Input
          label="Encryption Password"
          type="password"
          value={encPassword}
          onChange={(e) => setEncPassword(e.target.value)}
          placeholder="Required for sync"
        />
        {encPassword.trim() !== (local.encryptionPassword ?? '') && encPassword.trim() && (
          <div className="mt-2">
            <Input
              label="Confirm Password"
              type="password"
              value={encPasswordConfirm}
              onChange={(e) => setEncPasswordConfirm(e.target.value)}
              placeholder="Repeat password"
            />
          </div>
        )}
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
          All synced data is encrypted. All devices must use the same password.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={handleSave}>Save</Button>
        <Button size="sm" variant="secondary" onClick={handleTest} disabled={testing}>
          {testing ? 'Testing...' : 'Test Connection'}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => syncNow(true)}>Sync Now</Button>
        <Button size="sm" variant="ghost" onClick={() => forcePush()}>Force Push</Button>
        <Button size="sm" variant="ghost" onClick={() => forcePull()}>Force Pull</Button>
      </div>
      <div className="border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            if (window.confirm('This will permanently delete ALL tasks, lists, and subtasks on this device and all synced devices. This cannot be undone. Continue?')) {
              wipeAllData();
            }
          }}
        >
          Wipe All Data
        </Button>
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
          Deletes all tasks locally and remotely. Sync settings are preserved.
        </p>
      </div>
    </div>
  );
}
