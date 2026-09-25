import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLocalSettings, updateLocalSettings } from '../../hooks/use-settings';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/ConfirmDialog';
import { testConnection } from '../../sync/github-api';
import { syncNow, forcePush, forcePull, contentReplacedByLinking } from '../../sync/sync-engine';
import { deriveKey, cacheEncryptionKey, generateSalt, hasEncryptionKey } from '../../sync/crypto';
import {
  rotateSyncKey, hasUnfinishedRotation, discardUnfinishedRotation, type RotationProgress, type RotationResult,
} from '../../sync/key-rotation';
import { useVault } from '../../hooks/use-vault';
import { getVaultSecrets, setVaultSecrets, isRemoteUnlockEnrolled } from '../../db/vault';
import { recordError } from '../../lib/diagnostics';
import { checkSecretStrength } from '../../lib/password-strength';
import { PasswordStrengthBar } from '../ui/PasswordStrengthBar';
import { RotationProgressDialog } from './RotationProgressDialog';
import { requirePassphrase } from './passphrase-gate';

function describeContent({ lists, tasks, maps }: { lists: number; tasks: number; maps: number }): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [plural(lists, 'list'), plural(tasks, 'task')];
  if (maps > 0) parts.push(plural(maps, 'mindmap'));
  return parts.join(', ');
}

function rotationDoneMessage(result: RotationResult): string {
  const parts = ['Sync password changed. Enter it on your other devices.'];
  if (result.blobsUnreadable > 0) {
    parts.push(`${result.blobsUnreadable} shared file${result.blobsUnreadable === 1 ? '' : 's'} could not be re-encrypted and stay unreadable.`);
  }
  if (!result.historySquashed) parts.push('History will be compacted on a later sync.');
  return parts.join(' ');
}

export function GitHubSettings() {
  const local = useLocalSettings();
  const { enabled: paranoid, unlocked } = useVault();
  const [rotation, setRotation] = useState<RotationProgress | null>(null);
  const unfinishedRotation = useLiveQuery(() => hasUnfinishedRotation(), [], false);
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
    const newPassword = encPassword.trim();
    const passwordChanged = newPassword !== currentSyncPassword;
    const wasSyncEnabled = local.syncEnabled;
    const willEnableSync = !!(pat.trim() && repo.trim());
    // On a device that already syncs, a new password means re-encrypting the
    // whole repository under it (sync/key-rotation.ts) — run after the other
    // fields are saved, and only when this device can read the remote (a cached
    // key). An unfinished rotation is completed by saving its password again.
    const rotating = wasSyncEnabled && willEnableSync && !!newPassword && hasEncryptionKey()
      && (passwordChanged || !!unfinishedRotation);

    // Require confirmation when setting/changing password
    if (passwordChanged && newPassword) {
      // Same ACR-014 gate as EncryptionPasswordModal — this entry point must not
      // be a strength-check bypass.
      const strength = checkSecretStrength(newPassword, 'sync');
      if (!strength.ok) { toast(strength.reason!, 'error'); return; }
      if (encPassword !== encPasswordConfirm) {
        toast('Passwords do not match', 'error');
        return;
      }
    }

    // On a Paranoid device, where this device syncs is part of its protection: an
    // unlocked but unattended session must not be able to point it at another
    // repository (every later change would be streamed there) or swap the key.
    if (paranoid && unlocked) {
      const credentialsChanged = pat.trim() !== (getVaultSecrets()?.githubPat ?? '')
        || repo.trim() !== (local.githubRepo ?? '') || passwordChanged;
      if (credentialsChanged && await requirePassphrase('Your passphrase is needed to change where this device syncs.') === null) return;
    }

    // Linking replaces this device's content with what the repository already
    // holds (never merged — see contentReplacedByLinking). Say so before it
    // happens: it used to be silent, and the only copy was a safety backup.
    if (!wasSyncEnabled && willEnableSync) {
      const replaced = await contentReplacedByLinking(pat.trim(), repo.trim());
      if (replaced && !(await confirmDialog(
        `This device already has ${describeContent(replaced)}. If the repository already holds data, connecting ` +
        'replaces everything on this device with it — this device\'s items are not uploaded. A safety copy is kept ' +
        'in Settings → Backups; export a backup first if you want your own copy.',
        { confirmLabel: 'Connect and replace', danger: true },
      ))) return;
    }

    if (passwordChanged && newPassword) {
      if (!wasSyncEnabled) {
        // First-time setup: the first sync publishes this salt with the snapshot.
        const salt = generateSalt();
        const key = await deriveKey(newPassword, salt);
        cacheEncryptionKey(key, salt);
      }
    }
    // A rotation stores the new password itself, at the point the remote speaks it.
    const passwordToStore = rotating ? currentSyncPassword || undefined : newPassword || undefined;

    // Warn if enabling sync after changelog was pruned
    if (!wasSyncEnabled && willEnableSync && local.changelogPruned) {
      toast('Note: some older offline changes were pruned and will not sync', 'info');
      await updateLocalSettings({ changelogPruned: undefined });
    }

    if (paranoid) {
      if (!unlocked) { toast('Unlock the vault to change sync credentials', 'error'); return; }
      // Secrets go into the vault; localSettings keeps only the non-secret repo,
      // and the plaintext credential fields stay cleared.
      await setVaultSecrets({ githubPat: pat.trim() || undefined, syncPassword: passwordToStore });
      // Remote unlock/wipe deliberately keeps a plaintext copy of the PAT here:
      // it is the only way a LOCKED device can reach its mailbox. Clearing it on
      // every save silently killed the remote wipe (the watcher stops polling)
      // and the lock screen's "request unlock", while Settings still read
      // "Enabled" — the enrolment lives in the vault row, not in this field.
      const mailboxPat = (await isRemoteUnlockEnrolled()) ? pat.trim() || undefined : undefined;
      await updateLocalSettings({
        githubRepo: repo.trim() || undefined,
        syncEnabled: willEnableSync,
        githubPat: mailboxPat,
        encryptionPassword: undefined,
      });
    } else {
      await updateLocalSettings({
        githubPat: pat.trim() || undefined,
        githubRepo: repo.trim() || undefined,
        syncEnabled: willEnableSync,
        encryptionPassword: passwordToStore,
      });
    }
    toast('Sync settings saved', 'success');
    if (!rotating) return;

    const ok = await confirmDialog(
      unfinishedRotation
        ? 'Complete the unfinished password change? Enter the same new password you chose then. Everything in the repository is re-encrypted with it, and the old password stops working everywhere.'
        : 'Change the sync password? Everything in the repository — the snapshot, every shared file and the backups — is re-encrypted with the new password, and the old one stops working everywhere. Make sure your other devices are online and have synced first: changes they have not pushed yet would be lost. They will ask for the new password on their next sync.',
      { confirmLabel: 'Change password', danger: true },
    );
    if (!ok) { setEncPassword(currentSyncPassword); setEncPasswordConfirm(''); return; }
    setRotation({ phase: 'syncing' });
    try {
      const result = await rotateSyncKey(newPassword, setRotation);
      toast(rotationDoneMessage(result), 'success');
      setEncPasswordConfirm('');
    } catch (e) {
      recordError('sync.rotateKey', e);
      toast(e instanceof Error ? e.message : 'Could not change the sync password', 'error');
    } finally {
      setRotation(null);
    }
  }

  async function handleDiscardRotation() {
    const ok = await confirmDialog(
      'Forget the unfinished password change? The next password change starts from scratch; a shared file already re-encrypted under the forgotten password stays unreadable.',
      { confirmLabel: 'Forget it', danger: true },
    );
    if (!ok) return;
    await discardUnfinishedRotation();
    toast('Unfinished password change forgotten', 'info');
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
        {encPassword.trim() !== currentSyncPassword && encPassword.trim() !== '' && (
          <PasswordStrengthBar secret={encPassword.trim()} kind="sync" />
        )}
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
          All synced data is encrypted. All devices must use the same password. Changing it here
          re-encrypts everything in the repository, so sync your other devices first.
        </p>
      </div>
      {unfinishedRotation && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          A sync password change did not finish. Enter the new password you chose and Save to complete it.
          <button type="button" className="ml-2 underline" onClick={handleDiscardRotation}>Forget it</button>
        </div>
      )}
      <RotationProgressDialog progress={rotation} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={handleSave} disabled={!!rotation}>Save</Button>
        <Button size="sm" variant="secondary" onClick={handleTest} disabled={testing || !!rotation}>
          {testing ? 'Testing...' : 'Test Connection'}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => syncNow(true)} disabled={!!rotation}>Sync Now</Button>
        <Button size="sm" variant="ghost" onClick={() => forcePush()} disabled={!!rotation}>Force Push</Button>
        <Button size="sm" variant="ghost" onClick={() => forcePull()} disabled={!!rotation}>Force Pull</Button>
      </div>
    </div>
  );
}
