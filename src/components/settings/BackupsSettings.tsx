import { useState, useEffect } from 'react';
import { Button } from '../ui/Button';
import { useLocalSettings } from '../../hooks/use-settings';
import { listRemoteBackups, type BackupInfo } from '../../sync/remote-backups';
import { restoreFromBackup } from '../../sync/sync-engine';

export function BackupsSettings() {
  const local = useLocalSettings();
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

  if (!syncConfigured) {
    return (
      <div className="text-sm text-zinc-500 dark:text-zinc-400">
        Enable GitHub Sync to use remote backups.
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
