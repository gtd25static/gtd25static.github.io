import { useAppState } from '../../stores/app-state';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ThemeSettings } from './ThemeSettings';
import { GitHubSettings } from './GitHubSettings';
import { KeyboardSettings } from './KeyboardSettings';
import { wipeAllData } from '../../sync/sync-engine';

export function SettingsModal() {
  const { settingsOpen, setSettingsOpen } = useAppState();

  return (
    <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings">
      <div className="space-y-6">
        <ThemeSettings />
        <hr className="border-zinc-200 dark:border-zinc-700" />
        <GitHubSettings />
        <hr className="border-zinc-200 dark:border-zinc-700" />
        <KeyboardSettings />
        <hr className="border-zinc-200 dark:border-zinc-700" />
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
    </Modal>
  );
}
