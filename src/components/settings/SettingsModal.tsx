import { useAppState } from '../../stores/app-state';
import { Modal } from '../ui/Modal';
import { ThemeSettings } from './ThemeSettings';
import { GitHubSettings } from './GitHubSettings';
import { KeyboardSettings } from './KeyboardSettings';

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
      </div>
    </Modal>
  );
}
