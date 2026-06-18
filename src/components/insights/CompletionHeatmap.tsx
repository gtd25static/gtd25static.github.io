import type { HeatmapResult, HeatmapDay } from '../../hooks/use-insights';
import { formatDate } from '../../lib/date-utils';

function shadeClass(d: HeatmapDay, max: number): string {
  if (d.future) return 'bg-transparent';
  if (d.count === 0) return 'bg-zinc-100 dark:bg-zinc-800';
  const q = max <= 1 ? 1 : d.count / max;
  if (q > 0.66) return 'bg-accent-600';
  if (q > 0.33) return 'bg-accent-400';
  return 'bg-accent-200 dark:bg-accent-900';
}

/**
 * GitHub-style contribution calendar: one column per week (Monday-aligned),
 * one cell per day, shaded by completion count. Scrolls horizontally if needed.
 */
export function CompletionHeatmap({ result }: { result: HeatmapResult }) {
  const { days, weeks, maxCount } = result;
  const columns: HeatmapDay[][] = [];
  for (let c = 0; c < weeks; c++) columns.push(days.slice(c * 7, c * 7 + 7));

  return (
    <div className="overflow-x-auto pb-1">
      <div className="flex min-w-max gap-1">
        {columns.map((col, ci) => (
          <div key={ci} className="flex flex-col gap-1">
            {col.map((d) => (
              <div
                key={d.date}
                title={d.future ? '' : `${formatDate(d.date)}: ${d.count} completed`}
                className={`h-3 w-3 rounded-sm ${shadeClass(d, maxCount)}`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
