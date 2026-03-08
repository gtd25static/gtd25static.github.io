import { useSync } from '../../sync/use-sync';

export function SyncIndicator() {
  const { syncEnabled, pendingChanges, syncProgress } = useSync();

  if (!syncEnabled) return null;

  const isActive = syncProgress && syncProgress.phase !== 'done' && syncProgress.phase !== 'error';
  const isDone = syncProgress?.phase === 'done';

  // Active sync — show progress bar
  if (isActive) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-400">
        <div className="relative h-1 w-16 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-accent-500 transition-all duration-300"
            style={{ width: `${Math.round(syncProgress.progress * 100)}%` }}
          />
        </div>
        <span className="truncate">{syncProgress.label}</span>
      </div>
    );
  }

  // Just completed — show checkmark briefly
  if (isDone) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-green-500">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8l3.5 3.5L13 5" />
        </svg>
        Synced
      </div>
    );
  }

  // Idle — dot + status text
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-400">
      <div
        className={`h-1.5 w-1.5 rounded-full ${
          pendingChanges ? 'bg-yellow-500' : 'bg-green-500'
        }`}
      />
      {pendingChanges ? 'Pending' : 'Synced'}
    </div>
  );
}
