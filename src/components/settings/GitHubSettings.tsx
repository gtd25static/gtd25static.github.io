import { useState, useEffect } from 'react';
import { useLocalSettings, updateLocalSettings } from '../../hooks/use-settings';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { testConnection } from '../../sync/github-api';
import { syncNow, forcePush, forcePull } from '../../sync/sync-engine';
import { deriveKey, cacheEncryptionKey, generateSalt } from '../../sync/crypto';
import { useVault } from '../../hooks/use-vault';
import { getVaultSecrets, setVaultSecrets } from '../../db/vault';
import { recordError } from '../../lib/diagnostics';

export function GitHubSettings() {
  const local = useLocalSettings();
  const { enabled: paranoid, unlocked } = useVault();
  const [pat, setPat] = useState('');
  const [repo, setRepo] = useState('');
  const [encPassword, setEncPassword] = useState('');
  const [encPasswordConfirm, setEncPasswordConfirm] = useState('');
  const [testing, setTesting] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // The PAT and sync password live in the vault when Paranoid Mode is on, else
  // in localSettings. Repo is never secret, so always localSettings.
  const currentSyncPassword = paranoid ? (getVaultSecrets()?.syncPassword ?? '') : (local.encryptionPassword ?? '');

  // Sync local state when Dexie data (or the unlocked vault) loads.
  useEffect(() => {
    if (initialized) return;
    if (paranoid) {
      if (!unlocked) return; // wait until the vault is unlocked to read secrets
      const secrets = getVaultSecrets();
      setPat(secrets?.githubPat ?? '');
      setRepo(local.githubRepo ?? '');
      setEncPassword(secrets?.syncPassword ?? '');
      setInitialized(true);
    } else if (local.githubPat !== undefined) {
      setPat(local.githubPat ?? '');
      setRepo(local.githubRepo ?? '');
      setEncPassword(local.encryptionPassword ?? '');
      setInitialized(true);
    }
  }, [paranoid, unlocked, local.githubPat, local.githubRepo, local.encryptionPassword, initialized]);

  async function handleSave() {
    const passwordChanged = encPassword.trim() !== currentSyncPassword;

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

    const wasSyncEnabled = local.syncEnabled;
    const willEnableSync = !!(pat.trim() && repo.trim());

    // Warn if enabling sync after changelog was pruned
    if (!wasSyncEnabled && willEnableSync && local.changelogPruned) {
      toast('Note: some older offline changes were pruned and will not sync', 'info');
      await updateLocalSettings({ changelogPruned: undefined });
    }

    if (paranoid) {
      if (!unlocked) { toast('Unlock the vault to change sync credentials', 'error'); return; }
      // Secrets go into the vault; localSettings keeps only the non-secret repo,
      // and the plaintext credential fields stay cleared.
      await setVaultSecrets({ githubPat: pat.trim() || undefined, syncPassword: encPassword.trim() || undefined });
      await updateLocalSettings({
        githubRepo: repo.trim() || undefined,
        syncEnabled: willEnableSync,
        githubPat: undefined,
        encryptionPassword: undefined,
      });
    } else {
      await updateLocalSettings({
        githubPat: pat.trim() || undefined,
        githubRepo: repo.trim() || undefined,
        syncEnabled: willEnableSync,
        encryptionPassword: encPassword.trim() || undefined,
      });
    }
    toast('Sync settings saved', 'success');

    // Password change requires re-encrypting all remote data with new key.
    // Force push overwrites remote with local data encrypted using the new key.
    // Only do this when sync was already enabled (genuine password change),
    // NOT on initial setup — otherwise we'd overwrite remote data with an empty local DB.
    if (wasSyncEnabled && passwordChanged && encPassword.trim() && pat.trim() && repo.trim()) {
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
      if (!ok) recordError('github.connectionTest', new Error('Connection test returned a non-OK response'));
      toast(ok ? 'Connection successful!' : 'Connection failed', ok ? 'success' : 'error');
    } catch (err) {
      recordError('github.connectionTest', err);
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
        {encPassword.trim() !== currentSyncPassword && encPassword.trim() && (
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
    </div>
  );
}
