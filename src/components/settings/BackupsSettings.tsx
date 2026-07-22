import { useState, useEffect, useRef } from 'react';
import { Button } from '../ui/Button';
import { useLocalSettings } from '../../hooks/use-settings';
import { listRemoteBackups, type BackupInfo } from '../../sync/remote-backups';
import { restoreFromBackup, wipeAllData, importData } from '../../sync/sync-engine';
import { zipImportData } from '../../db/export-import';
import { getLocalBackups, readLocalBackup } from '../../db/backup';
import { parseImportZip } from '../../db/export-import';
import { ExportDialog } from './ExportDialog';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/ConfirmDialog';
import { promptPassword } from '../ui/PasswordPrompt';
import { useVault } from '../../hooks/use-vault';
import { getVaultSecrets } from '../../db/vault';
import { recordError } from '../../lib/diagnostics';

export function BackupsSettings() {
  const local = useLocalSettings();
  const { enabled: paranoid } = useVault();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringTier, setRestoringTier] = useState<string | null>(null);
  const [restoringLocalKey, setRestoringLocalKey] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);

  // Paranoid devices keep the PAT in the vault; the remote-backup READ/restore
  // path still works (only the create path is disabled). Non-paranoid: localSettings.
  const pat = paranoid ? getVaultSecrets()?.githubPat : local.githubPat;
  const syncPassword = paranoid ? getVaultSecrets()?.syncPassword : local.encryptionPassword;
  const repo = local.githubRepo;
  const syncConfigured = local.syncEnabled && !!pat && !!repo;

  useEffect(() => {
    if (!syncConfigured) return;
    fetchBackups();
  }, [syncConfigured]);

  async function fetchBackups() {
    if (!pat || !repo) return;
    setLoading(true);
    try {
      const result = await listRemoteBackups(pat, repo);
      setBackups(result);
    } catch (err) {
      recordError('backups.listRemote', err);
      // Silently fail — user can retry
    } finally {
      setLoading(false);
    }
  }

  async function handleRestore(tier: BackupInfo['tier']) {
    if (!await confirmDialog(
      'This will replace all current data with this backup and sync the change to all devices. Continue?',
      { confirmLabel: 'Restore', danger: false },
    )) return;

    setRestoringTier(tier);
    try {
      await restoreFromBackup(tier);
      await fetchBackups();
    } finally {
      setRestoringTier(null);
    }
  }

  // Boot-time safety backups (localStorage; not created under Paranoid).
  const localBackups = paranoid ? [] : getLocalBackups();

  async function handleRestoreLocal(backup: { key: string; timestamp: number }) {
    if (!await confirmDialog(
      `This will replace all current data with the safety backup from ${new Date(backup.timestamp).toLocaleString()} and sync the change to all devices. Continue?`,
      { confirmLabel: 'Restore', danger: false },
    )) return;

    setRestoringLocalKey(backup.key);
    try {
      await importData(readLocalBackup(backup.key));
    } catch (err) {
      recordError('backups.restoreLocal', err);
      toast(err instanceof Error ? err.message : 'Restore failed', 'error');
    } finally {
      setRestoringLocalKey(null);
    }
  }

  // Safety backups only live in this device's localStorage; downloading one
  // packages it in the standard backup zip so another device can import it.
  async function handleDownloadLocal(backup: { key: string; timestamp: number }) {
    try {
      const blob = await zipImportData(readLocalBackup(backup.key), backup.timestamp);
      const stamp = new Date(backup.timestamp).toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gtd25-safety-backup-${stamp}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      recordError('backups.downloadLocal', err);
      toast(err instanceof Error ? err.message : 'Download failed', 'error');
    }
  }

  async function handleImportFile(file: File) {
    try {
      const data = await parseImportZip(file, {
        syncPassword,
        getPassword: () => promptPassword('Encrypted backup', {
          message: 'This backup is encrypted. Enter its passphrase to import.',
          confirmLabel: 'Import',
        }),
      });
      if (!await confirmDialog('This will replace all current data with the backup. Continue?', { confirmLabel: 'Import', danger: false })) return;
      await importData(data);
    } catch (err) {
      console.error('Import failed:', err);
      recordError('backups.importFile', err);
      toast(err instanceof Error ? err.message : 'Import failed', 'error');
    }
  }

  const localBackupSection = (
    <>
      <div>
        <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Local Backups</h3>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => setShowExport(true)}>
          Export Backup
        </Button>
        <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
          Import Backup
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportFile(file);
            e.target.value = '';
          }}
        />
      </div>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Export downloads a zip backup of all tasks. Import replaces all data and syncs to other devices.
      </p>
      <ExportDialog
        open={showExport}
        onClose={() => setShowExport(false)}
        syncPassword={syncPassword}
        defaultEncrypted={paranoid}
      />
      {localBackups.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Safety Backups</h3>
          {localBackups.map((b) => (
            <div
              key={b.key}
              className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700"
            >
              <div className="text-xs text-zinc-400 dark:text-zinc-500">
                {new Date(b.timestamp).toLocaleString()}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleDownloadLocal(b)}
                >
                  Download
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={restoringLocalKey !== null}
                  onClick={() => handleRestoreLocal(b)}
                >
                  {restoringLocalKey === b.key ? 'Restoring...' : 'Restore'}
                </Button>
              </div>
            </div>
          ))}
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Created automatically on this device at app start; they hold lists, tasks and subtasks (not mindmaps).
            Restore replaces that data and syncs to other devices. Download saves an unencrypted backup zip you
            can import on another device.
          </p>
        </div>
      )}
      <div>
        <Button
          size="sm"
          variant="danger"
          onClick={async () => {
            const message = syncConfigured
              ? 'This will delete ALL tasks, lists, subtasks, and shared items on this device and every synced device. Encrypted remote backups (including a pre-wipe safety backup) are kept in the sync repo and can be restored later.'
              : 'This will delete ALL tasks, lists, subtasks, and shared items on this device. Sync is not configured, so there is no remote backup to restore from — this cannot be undone.';
            if (await confirmDialog(message, { confirmLabel: 'Wipe All Data', typeToConfirm: 'yes' })) {
              wipeAllData();
            }
          }}
        >
          Wipe All Data
        </Button>
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
          {syncConfigured
            ? 'Deletes all tasks locally and remotely. Encrypted remote backups are kept and can be restored. Sync settings are preserved.'
            : 'Deletes all tasks on this device. Sync settings are preserved.'}
        </p>
      </div>
    </>
  );

  if (!syncConfigured) {
    return (
      <div className="space-y-4">
        {localBackupSection}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {localBackupSection}

      <hr className="border-zinc-200 dark:border-zinc-700" />

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Remote Backups</h3>
        <Button size="sm" variant="ghost" onClick={fetchBackups} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </Button>
      </div>

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Backups are created automatically during sync (hourly, daily, weekly).
      </p>

      {loading && backups.length === 0 ? (
        <div className="text-sm text-zinc-400">Loading backups...</div>
      ) : backups.length === 0 ? (
        <div className="text-sm text-zinc-400">
          No backups available yet. Backups are created automatically after sync.
        </div>
      ) : (
        <div className="space-y-2">
          {backups.map((backup) => (
            <div
              key={backup.tier}
              className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700"
            >
              <div>
                <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {backup.tier.charAt(0).toUpperCase() + backup.tier.slice(1)}
                </div>
                <div className="text-xs text-zinc-400 dark:text-zinc-500">
                  {new Date(backup.backedUpAt).toLocaleString()}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={restoringTier !== null}
                onClick={() => handleRestore(backup.tier)}
              >
                {restoringTier === backup.tier ? 'Restoring...' : 'Restore'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
