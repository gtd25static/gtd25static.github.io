import type { RhythmResult } from '../../hooks/use-insights';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function MiniBars({
  title,
  values,
  highlight,
  labelAt,
}: {
  title: string;
  values: number[];
  highlight: number | null;
  labelAt: (i: number) => string;
}) {
  const max = Math.max(1, ...values);
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">{title}</p>
      <div className="flex h-20 items-end gap-0.5">
        {values.map((v, i) => (
          <div
            key={i}
            className="flex h-full min-w-0 flex-1 items-end"
            title={`${labelAt(i) || i}: ${v}`}
          >
            <div
              className={`w-full rounded-t transition-all ${
                i === highlight ? 'bg-accent-500' : 'bg-zinc-200 dark:bg-zinc-700'
              }`}
              style={{ height: `${(v / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-0.5">
        {values.map((_, i) => (
          <div key={i} className="min-w-0 flex-1 text-center text-[9px] text-zinc-400">
            {labelAt(i)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Two small histograms: completions by weekday and by hour-of-day. */
export function RhythmBars({ rhythm }: { rhythm: RhythmResult }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <MiniBars
        title="By weekday"
        values={rhythm.byWeekday}
        highlight={rhythm.peakWeekday}
        labelAt={(i) => WEEKDAYS[i]}
      />
      <MiniBars
        title="By hour"
        values={rhythm.byHour}
        highlight={rhythm.peakHour}
        labelAt={(i) => (i % 6 === 0 ? `${i}` : '')}
      />
    </div>
  );
}
