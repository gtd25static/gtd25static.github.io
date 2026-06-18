import type { FlowBucket } from '../../hooks/use-insights';

/**
 * Paired vertical bars per time bucket: incoming (created, neutral) next to
 * outgoing (completed, accent). Hand-rolled CSS bars — no charting dependency.
 */
export function FlowChart({ buckets }: { buckets: FlowBucket[] }) {
  const max = Math.max(1, ...buckets.flatMap((b) => [b.created, b.completed]));
  const labelEvery = buckets.length <= 12 ? 1 : Math.ceil(buckets.length / 8);

  return (
    <div>
      <div className="flex h-28 items-end gap-1">
        {buckets.map((b) => (
          <div
            key={b.start}
            className="flex h-full flex-1 items-end justify-center gap-0.5"
            title={`${b.label}: ${b.created} in · ${b.completed} out`}
          >
            <div
              className="w-1/2 max-w-[10px] rounded-t bg-zinc-300 transition-all dark:bg-zinc-600"
              style={{ height: `${(b.created / max) * 100}%` }}
            />
            <div
              className="w-1/2 max-w-[10px] rounded-t bg-accent-500 transition-all"
              style={{ height: `${(b.completed / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1">
        {buckets.map((b, i) => (
          <div key={b.start} className="min-w-0 flex-1 truncate text-center text-[10px] text-zinc-400">
            {i % labelEvery === 0 ? b.label : ''}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-zinc-300 dark:bg-zinc-600" /> Created
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-accent-500" /> Completed
        </span>
      </div>
    </div>
  );
}
