import { useState } from 'react';
import type { ReactNode } from 'react';
import { useInsights, type InsightsRange } from '../../hooks/use-insights';
import { FlowChart } from './FlowChart';
import { CompletionHeatmap } from './CompletionHeatmap';
import { RhythmBars } from './RhythmBars';

const RANGES: { id: InsightsRange; label: string }[] = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];
const RANGE_NOUN: Record<InsightsRange, string> = {
  week: 'this week',
  month: 'this month',
  year: 'this year',
};
const WEEKDAYS_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w`;
  return `${Math.round(days / 30)}mo`;
}

function timeOfDayLabel(hour: number): string {
  if (hour < 6) return 'at night';
  if (hour < 12) return 'in the morning';
  if (hour < 17) return 'in the afternoon';
  if (hour < 21) return 'in the evening';
  return 'at night';
}

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      {children}
    </section>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{title}</h2>
      {hint && <p className="text-xs text-zinc-400 dark:text-zinc-500">{hint}</p>}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'good' | 'bad';
}) {
  const valColor =
    tone === 'good'
      ? 'text-green-600 dark:text-green-400'
      : tone === 'bad'
        ? 'text-red-500 dark:text-red-400'
        : 'text-zinc-900 dark:text-zinc-100';
  return (
    <div className="rounded-lg bg-zinc-50 px-3 py-2.5 dark:bg-zinc-800/50">
      <p className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${valColor}`}>{value}</p>
      {sub && <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{sub}</p>}
    </div>
  );
}

function BarRow({
  label,
  count,
  max,
  tone = 'accent',
}: {
  label: string;
  count: number;
  max: number;
  tone?: 'accent' | 'zinc';
}) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  const bar = tone === 'accent' ? 'bg-accent-500' : 'bg-zinc-300 dark:bg-zinc-600';
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="w-28 shrink-0 truncate text-sm text-zinc-600 dark:text-zinc-300" title={label}>
        {label}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className={`h-full rounded-full transition-all ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-6 shrink-0 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
        {count}
      </span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-zinc-200 px-6 py-12 text-center dark:border-zinc-700/60">
      <div className="text-base font-medium text-zinc-700 dark:text-zinc-300">No activity yet</div>
      <p className="text-sm text-zinc-400 dark:text-zinc-500">
        Create and complete a few tasks and your stats will show up here.
      </p>
    </div>
  );
}

export function InsightsView() {
  const [range, setRange] = useState<InsightsRange>('month');
  const data = useInsights(range);

  const followUpTotal = data ? data.followUps.activeCount + data.followUps.resolvedCount : 0;
  const openTotal = data ? data.cycle.openAgeBuckets.reduce((n, b) => n + b.count, 0) : 0;
  const openMax = data ? Math.max(1, ...data.cycle.openAgeBuckets.map((b) => b.count)) : 1;
  const perListMax = data ? Math.max(1, ...data.totals.perList.map((l) => l.count)) : 1;
  const topicMax = data ? Math.max(1, ...data.followUps.topTopics.map((t) => t.count)) : 1;
  const activePct = data
    ? Math.round((data.heatmap.activeDays / Math.max(1, data.heatmap.elapsedDays)) * 100)
    : 0;

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-5 px-1">
          <h1 className="text-lg font-medium text-zinc-800 dark:text-zinc-100">Insights</h1>
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            Patterns in how you capture and clear your work.
          </p>
        </div>

        <div className="mb-5 inline-flex rounded-full border border-zinc-200 p-0.5 dark:border-zinc-700">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                range === r.id
                  ? 'bg-accent-500 text-white'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {data === undefined ? (
          <p className="px-1 text-sm text-zinc-400 dark:text-zinc-500">Crunching your numbers…</p>
        ) : !data.hasAnyData ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-5">
            {/* Flow: in vs out */}
            <Card>
              <SectionTitle title="Flow" hint={`Tasks created vs. completed ${RANGE_NOUN[range]}`} />
              <div className="mb-4 grid grid-cols-3 gap-3">
                <StatCard
                  label="Came in"
                  value={data.flow.created}
                  sub={`${data.flow.avgCreatedPerDay.toFixed(1)}/day`}
                />
                <StatCard
                  label="Cleared"
                  value={data.flow.completed}
                  sub={`${data.flow.avgCompletedPerDay.toFixed(1)}/day`}
                />
                <StatCard
                  label="Net"
                  value={`${data.flow.net >= 0 ? '+' : ''}${data.flow.net}`}
                  sub={
                    data.flow.net > 0
                      ? 'backlog shrank'
                      : data.flow.net < 0
                        ? 'backlog grew'
                        : 'broke even'
                  }
                  tone={data.flow.net > 0 ? 'good' : data.flow.net < 0 ? 'bad' : undefined}
                />
              </div>
              <FlowChart buckets={data.flow.buckets} />
            </Card>

            {/* Consistency: heatmap + streaks */}
            <Card>
              <SectionTitle title="Consistency" hint="Completions over the last 6 months" />
              <div className="mb-4 grid grid-cols-3 gap-3">
                <StatCard label="Current streak" value={`${data.streak.current}d`} />
                <StatCard label="Longest streak" value={`${data.streak.longest}d`} />
                <StatCard label="Active days" value={`${activePct}%`} />
              </div>
              <CompletionHeatmap result={data.heatmap} />
            </Card>

            {/* Rhythm: when work gets done */}
            <Card>
              <SectionTitle title="Rhythm" hint="When you tend to finish things (all-time)" />
              {data.rhythm.total > 0 && data.rhythm.peakWeekday !== null && data.rhythm.peakHour !== null && (
                <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
                  You finish most tasks on{' '}
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">
                    {WEEKDAYS_FULL[data.rhythm.peakWeekday]}s
                  </span>{' '}
                  {timeOfDayLabel(data.rhythm.peakHour)}.
                </p>
              )}
              <RhythmBars rhythm={data.rhythm} />
            </Card>

            {/* Cycle time: how long things take / what's aging */}
            <Card>
              <SectionTitle title="Cycle time" hint="How long things take, and what's piling up" />
              <div className="mb-4">
                <StatCard
                  label="Median time to complete"
                  value={data.cycle.medianLeadMs !== null ? formatDuration(data.cycle.medianLeadMs) : '—'}
                  sub={`${data.cycle.completedCount} completed`}
                />
              </div>
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Open tasks by age</p>
              {openTotal > 0 ? (
                data.cycle.openAgeBuckets.map((b) => (
                  <BarRow key={b.label} label={b.label} count={b.count} max={openMax} tone="zinc" />
                ))
              ) : (
                <p className="py-1 text-sm text-zinc-400 dark:text-zinc-500">Nothing open — all clear.</p>
              )}
            </Card>

            {/* Follow-ups: only when the user has any */}
            {followUpTotal > 0 && (
              <Card>
                <SectionTitle title="Follow-ups" hint={`Discussions logged ${RANGE_NOUN[range]}`} />
                <div className="mb-4 grid grid-cols-3 gap-3">
                  <StatCard
                    label="Discussions"
                    value={data.followUps.discussionsInRange}
                    sub={`${data.followUps.totalDiscussions} all-time`}
                  />
                  <StatCard label="Active" value={data.followUps.activeCount} />
                  <StatCard label="Resolved" value={data.followUps.resolvedCount} />
                </div>
                {data.followUps.topTopics.length > 0 && (
                  <>
                    <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Most discussed</p>
                    {data.followUps.topTopics.map((t) => (
                      <BarRow key={t.title} label={t.title} count={t.count} max={topicMax} />
                    ))}
                  </>
                )}
              </Card>
            )}

            {/* Where work happens + lifetime totals */}
            <Card>
              <SectionTitle title="Where your work happens" hint="Completed tasks by list (all-time)" />
              {data.totals.perList.length > 0 ? (
                data.totals.perList.map((l) => (
                  <BarRow key={l.title} label={l.title} count={l.count} max={perListMax} />
                ))
              ) : (
                <p className="py-1 text-sm text-zinc-400 dark:text-zinc-500">No completed tasks yet.</p>
              )}
              <div className="mt-4 grid grid-cols-3 gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                <StatCard label="Completed" value={data.totals.completed} />
                <StatCard label="Open" value={data.totals.activeTasks} />
                <StatCard label="Follow-ups" value={data.totals.followUpsActive} />
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
