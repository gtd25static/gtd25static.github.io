import { formatBytes, type SharedStorage } from '../../hooks/use-shared-items';

// Storage-used bar shown at the top of the Shared Folder, nudging the user to
// delete items as it fills (green → amber → red).
export function StorageBar({ storage }: { storage: SharedStorage }) {
  const { usedBytes, totalBytes } = storage;
  const pct = totalBytes > 0 ? Math.min(100, (usedBytes / totalBytes) * 100) : 0;
  const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-accent-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>{formatBytes(usedBytes)} of {formatBytes(totalBytes)} used</span>
        <span>{Math.round(pct)}%</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Shared folder storage used"
      >
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
