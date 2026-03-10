import { useState, useEffect, useRef } from 'react';
import { Button } from '../ui/Button';
import { useLocalSettings } from '../../hooks/use-settings';
import { listRemoteBackups, type BackupInfo } from '../../sync/remote-backups';
import { restoreFromBackup, wipeAllData, importData } from '../../sync/sync-engine';
import { exportToZip, parseImportZip } from '../../db/export-import';
import { toast } from '../ui/Toast';

export function BackupsSettings() {
  const local = useLocalSettings();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringTier, setRestoringTier] = useState<string | null>(null);

  const syncConfigured = local.syncEnabled && !!local.githubPat && !!local.githubRepo;

  useEffect(() => {
    if (!syncConfigured) return;
    fetchBackups();
  }, [syncConfigured]);

  async function fetchBackups() {
    if (!local.githubPat || !local.githubRepo) return;
    setLoading(true);
    try {
      const result = await listRemoteBackups(local.githubPat, local.githubRepo);
      setBackups(result);
    } catch {
      // Silently fail — user can retry
    } finally {
      setLoading(false);
    }
  }

  async function handleRestore(tier: BackupInfo['tier']) {
    if (!window.confirm(
      'This will replace all current data with this backup and sync the change to all devices. Continue?',
    )) return;

    setRestoringTier(tier);
    try {
      await restoreFromBackup(tier);
      await fetchBackups();
    } finally {
      setRestoringTier(null);
    }
  }

  async function handleExport() {
    try {
      const blob = await exportToZip();
      const date = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gtd25-backup-${date}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
      toast('Export failed', 'error');
    }
  }

  async function handleImportFile(file: File) {
    try {
      const data = await parseImportZip(file);
      if (!window.confirm('This will replace all current data with the backup. Continue?')) return;
      await importData(data);
    } catch (err) {
      console.error('Import failed:', err);
      toast(err instanceof Error ? err.message : 'Import failed', 'error');
    }
  }

  const localBackupSection = (
    <>
      <div>
        <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Local Backups</h3>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={handleExport}>
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
      <div>
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
