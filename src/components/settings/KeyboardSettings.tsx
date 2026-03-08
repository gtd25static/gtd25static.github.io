import { DEFAULT_KEYBOARD_SHORTCUTS } from '../../lib/constants';

export function KeyboardSettings() {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">Keyboard Shortcuts</h3>
      <div className="space-y-1">
        {Object.entries(DEFAULT_KEYBOARD_SHORTCUTS).map(([action, key]) => (
          <div key={action} className="flex items-center justify-between rounded px-2 py-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">{formatAction(action)}</span>
            <kbd className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-mono dark:bg-zinc-700 dark:text-zinc-200">{key}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatAction(action: string): string {
  return action.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}
