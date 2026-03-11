import { useState } from 'react';
import { useAppState } from '../../stores/app-state';
import { useShallow } from 'zustand/react/shallow';
import { Modal } from '../ui/Modal';
import { ThemeSettings } from './ThemeSettings';
import { GitHubSettings } from './GitHubSettings';
import { KeyboardSettings } from './KeyboardSettings';
import { BackupsSettings } from './BackupsSettings';

type SettingsTab = 'general' | 'backups';

export function SettingsModal() {
  const { settingsOpen, setSettingsOpen } = useAppState(useShallow(s => ({ settingsOpen: s.settingsOpen, setSettingsOpen: s.setSettingsOpen })));
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

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
          </>
        ) : (
          <BackupsSettings />
        )}
      </div>
    </Modal>
  );
}
