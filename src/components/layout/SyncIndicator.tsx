import { useSyncContext } from '../../sync/use-sync';

function friendlyError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('fetch') || lower.includes('network') || lower.includes('offline'))
    return 'No connection';
  if (lower.includes('conflict')) return 'Conflict';
  if (lower.includes('401') || lower.includes('auth') || lower.includes('token'))
    return 'Auth error';
  if (lower.includes('timeout')) return 'Timeout';
  if (lower.includes('password') || lower.includes('decrypt'))
    return 'Wrong password';
  return 'Sync error';
}

function SyncCounts({ pulled, pushed }: { pulled: number; pushed: number }) {
  if (pulled === 0 && pushed === 0) return null;
  return (
    <span className="text-[11px] tabular-nums">
      {pulled > 0 && <span>{'\u2193'}{pulled}</span>}
      {pulled > 0 && pushed > 0 && ' '}
      {pushed > 0 && <span>{'\u2191'}{pushed}</span>}
    </span>
  );
}

export function SyncIndicator() {
  const { syncEnabled, pendingChanges, syncProgress, lastSyncStats, lastError, triggerSync } = useSyncContext();

  if (!syncEnabled) return null;

  const isActive = syncProgress && syncProgress.phase !== 'done' && syncProgress.phase !== 'error';
  const isDone = syncProgress?.phase === 'done';
  const isError = syncProgress?.phase === 'error';

  // Active sync — spinning icon + phase label
  if (isActive) {
    return (
      <button
        onClick={triggerSync}
        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-zinc-400 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        title="Syncing..."
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="animate-spin text-accent-500">
          <path d="M8 1a7 7 0 016.93 6h-2.02A5 5 0 008 3V1z" fill="currentColor" />
        </svg>
        <span className="truncate">{syncProgress.label}</span>
      </button>
    );
  }

  // Error — red dot + friendly message
  if (isError || lastError) {
    const errorMsg = lastError || syncProgress?.label || 'Sync error';
    return (
      <button
        onClick={triggerSync}
        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-red-500 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        title={`Click to retry: ${errorMsg}`}
      >
        <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
        <span className="truncate">{friendlyError(errorMsg)}</span>
      </button>
    );
  }

  // Just completed — green check + counts
  if (isDone) {
    const pulled = syncProgress.pulled ?? 0;
    const pushed = syncProgress.pushed ?? 0;
    return (
      <button
        onClick={triggerSync}
        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-green-500 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        title="Click to sync"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8l3.5 3.5L13 5" />
        </svg>
        {pulled > 0 || pushed > 0 ? (
          <SyncCounts pulled={pulled} pushed={pushed} />
        ) : (
          <span>Synced</span>
        )}
      </button>
    );
  }

  // Idle with last stats
  if (lastSyncStats && (lastSyncStats.pulled > 0 || lastSyncStats.pushed > 0) && !pendingChanges) {
    return (
      <button
        onClick={triggerSync}
        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-green-500 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        title="Click to sync"
      >
        <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
        <SyncCounts pulled={lastSyncStats.pulled} pushed={lastSyncStats.pushed} />
      </button>
    );
  }

  // Idle pending or clean
  return (
    <button
      onClick={triggerSync}
      className={`flex items-center gap-1.5 rounded-full px-2 py-1 text-xs cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors ${
        pendingChanges ? 'text-yellow-600 dark:text-yellow-500' : 'text-zinc-400'
      }`}
      title="Click to sync"
    >
      <div
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          pendingChanges ? 'bg-yellow-500' : 'bg-green-500'
        }`}
      />
      {pendingChanges ? 'Pending' : 'Synced'}
    </button>
  );
}
