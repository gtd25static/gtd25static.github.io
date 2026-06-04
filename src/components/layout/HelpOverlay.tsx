import { useShallow } from 'zustand/react/shallow';
import { useAppState } from '../../stores/app-state';
import { DEFAULT_KEYBOARD_SHORTCUTS } from '../../lib/constants';
import { Modal } from '../ui/Modal';

export function HelpOverlay() {
  const { helpOpen, setHelpOpen } = useAppState(useShallow(s => ({ helpOpen: s.helpOpen, setHelpOpen: s.setHelpOpen })));

  const shortcuts = [
    { key: DEFAULT_KEYBOARD_SHORTCUTS.navigateDown, desc: 'Navigate down' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.navigateUp, desc: 'Navigate up' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.navigateLeft, desc: 'Move to sidebar' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.navigateRight, desc: 'Move to main' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.expand, desc: 'Expand / select' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.startWorking, desc: 'Start working' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.editTitle, desc: 'Edit title' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.addSubtask, desc: 'Add subtask' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.collapse, desc: 'Cancel / close' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.newTask, desc: 'New task' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.markDone, desc: 'Toggle done' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.markBlocked, desc: 'Toggle blocked' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.workOn, desc: 'Start working on' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.search, desc: 'Focus search' },
    { key: 'Ctrl+n', desc: 'Quick capture to Inbox' },
    { key: 'v', desc: 'Toggle bulk select mode' },
    { key: 'r', desc: 'Weekly review' },
    { key: DEFAULT_KEYBOARD_SHORTCUTS.help, desc: 'Toggle this help' },
  ];

  return (
    <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard Shortcuts">
      <div className="space-y-1">
        {shortcuts.map((s) => (
          <div key={s.key} className="flex items-center justify-between py-1.5">
            <span className="text-sm text-zinc-600 dark:text-zinc-400">{s.desc}</span>
            <kbd className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-mono dark:bg-zinc-700 dark:text-zinc-200">{s.key}</kbd>
          </div>
        ))}
      </div>
    </Modal>
  );
}
