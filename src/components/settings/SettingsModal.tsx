import { useRef, useState } from 'react';
import { useAppState } from '../../stores/app-state';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ThemeSettings } from './ThemeSettings';
import { GitHubSettings } from './GitHubSettings';
import { KeyboardSettings } from './KeyboardSettings';
import { BackupsSettings } from './BackupsSettings';
import { wipeAllData, importData } from '../../sync/sync-engine';
import { exportToZip, parseImportZip } from '../../db/export-import';
import { toast } from '../ui/Toast';

type SettingsTab = 'general' | 'backups';

export function SettingsModal() {
  const { settingsOpen, setSettingsOpen } = useAppState();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  return (
    <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings">
      <div className="space-y-6">
        {/* Tab bar */}
        <div className="flex gap-4 border-b border-zinc-200 dark:border-zinc-700">
          {([['general', 'General'], ['backups', 'Backups']] as const).map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-2 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'border-b-2 border-accent-600 text-accent-600 dark:text-accent-400 dark:border-accent-400'
                  : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === 'general' ? (
          <>
            <ThemeSettings />
            <hr className="border-zinc-200 dark:border-zinc-700" />
            <GitHubSettings />
            <hr className="border-zinc-200 dark:border-zinc-700" />
            <KeyboardSettings />
            <hr className="border-zinc-200 dark:border-zinc-700" />
            <div className="space-y-4">
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
            </div>
          </>
        ) : (
          <BackupsSettings />
        )}
      </div>
    </Modal>
  );
}
