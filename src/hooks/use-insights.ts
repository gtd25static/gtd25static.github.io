import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { DiscussionEntry } from '../db/models';
import {
  startOfDay,
  startOfWeek,
  startOfMonth,
  isWeekend,
  computeStreak,
} from './use-motivation-stats';

const DAY_MS = 24 * 60 * 60 * 1000;

export type InsightsRange = 'week' | 'month' | 'year';

// ── Shared shapes ───────────────────────────────────────────────────────────

/** A unit of tracked work (a task or subtask) reduced to its lifecycle stamps. */
export interface WorkItem {
  createdAt: number;
  completedAt?: number;
  done: boolean;
}

export interface FlowBucket {
  start: number;
  label: string;
  created: number;
  completed: number;
}

export interface FlowResult {
  created: number;
  completed: number;
  net: number; // completed - created; positive ⇒ clearing backlog faster than adding
  days: number;
  avgCreatedPerDay: number;
  avgCompletedPerDay: number;
  buckets: FlowBucket[];
}

export interface HeatmapDay {
  date: number; // start-of-day timestamp
  count: number;
  future: boolean; // day lies after "today" (rendered as an empty placeholder)
}

export interface HeatmapResult {
  days: HeatmapDay[]; // chronological, Monday-aligned, length = weeks * 7
  weeks: number;
  maxCount: number;
  activeDays: number;
  elapsedDays: number; // days from window start through today (for the active %)
}

export interface RhythmResult {
  byWeekday: number[]; // length 7, index 0 = Monday
  byHour: number[]; // length 24
  peakWeekday: number | null;
  peakHour: number | null;
  total: number;
}

export interface AgeBucket {
  label: string;
  count: number;
}

export interface CycleTimeResult {
  medianLeadMs: number | null; // median createdAt→completedAt over completed items
  completedCount: number;
  openAgeBuckets: AgeBucket[];
}

export interface TopicCount {
  title: string;
  count: number;
}

export interface FollowUpResult {
  discussionsInRange: number;
  totalDiscussions: number;
  activeCount: number;
  resolvedCount: number;
  topTopics: TopicCount[];
}

export interface InsightsData {
  range: InsightsRange;
  flow: FlowResult;
  heatmap: HeatmapResult;
  rhythm: RhythmResult;
  cycle: CycleTimeResult;
  followUps: FollowUpResult;
  streak: { current: number; longest: number };
  totals: {
    completed: number;
    activeTasks: number;
    followUpsActive: number;
    perList: TopicCount[];
  };
  hasAnyData: boolean;
}

// ── Small date helpers (DST-robust via setDate, mirroring use-motivation-stats) ─

function addDays(ts: number, delta: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + delta);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function prevWeekday(ts: number): number {
  let cur = addDays(ts, -1);
  while (isWeekend(new Date(cur))) cur = addDays(cur, -1);
  return cur;
}

function nextWeekday(ts: number): number {
  let cur = addDays(ts, 1);
  while (isWeekend(new Date(cur))) cur = addDays(cur, 1);
  return cur;
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Monday-first weekday index (0 = Mon … 6 = Sun). */
function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function argmax(arr: number[]): number | null {
  let best = -1;
  let bestVal = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > bestVal) {
      bestVal = arr[i];
      best = i;
    }
  }
  return best === -1 ? null : best;
}

// ── Pure aggregators (exported for unit testing) ────────────────────────────

/**
 * Tasks created ("in") vs completed ("out") over the selected range, bucketed
 * for charting: daily for week (7) and month (~30), monthly for year (12).
 */
export function computeFlow(
  items: ReadonlyArray<{ createdAt: number; completedAt?: number }>,
  range: InsightsRange,
  now: number,
): FlowResult {
  const buckets: FlowBucket[] = [];
  const indexOf = new Map<number, number>(); // bucket-key → index
  let keyForCreate: (ts: number) => number | undefined;
  let windowStart: number;

  if (range === 'year') {
    const monthStart = startOfMonth(new Date(now));
    for (let i = 11; i >= 0; i--) {
      const d = new Date(monthStart);
      d.setMonth(d.getMonth() - i);
      const start = d.getTime();
      indexOf.set(d.getFullYear() * 12 + d.getMonth(), buckets.length);
      buckets.push({ start, label: MONTH_LABELS[d.getMonth()], created: 0, completed: 0 });
    }
    windowStart = buckets[0].start;
    keyForCreate = (ts) => {
      const d = new Date(ts);
      return indexOf.get(d.getFullYear() * 12 + d.getMonth());
    };
  } else {
    const span = range === 'week' ? 7 : 30;
    const todayStart = startOfDay(new Date(now));
    for (let i = span - 1; i >= 0; i--) {
      const start = addDays(todayStart, -i);
      const d = new Date(start);
      const label = range === 'week' ? WEEKDAY_LABELS[weekdayIndex(d)] : String(d.getDate());
      indexOf.set(start, buckets.length);
      buckets.push({ start, label, created: 0, completed: 0 });
    }
    windowStart = buckets[0].start;
    keyForCreate = (ts) => indexOf.get(startOfDay(new Date(ts)));
  }

  let created = 0;
  let completed = 0;
  for (const it of items) {
    const ci = keyForCreate(it.createdAt);
    if (ci !== undefined) {
      buckets[ci].created++;
      created++;
    }
    if (it.completedAt !== undefined) {
      const di = keyForCreate(it.completedAt);
      if (di !== undefined) {
        buckets[di].completed++;
        completed++;
      }
    }
  }

  const days = Math.max(1, Math.round((startOfDay(new Date(now)) - windowStart) / DAY_MS) + 1);
  return {
    created,
    completed,
    net: completed - created,
    days,
    avgCreatedPerDay: created / days,
    avgCompletedPerDay: completed / days,
    buckets,
  };
}

/**
 * GitHub-style completion calendar for the trailing `weeks` weeks, Monday-aligned
 * so each column is a full week. Days after today are flagged `future`.
 */
export function buildHeatmap(completions: ReadonlyArray<number>, now: number, weeks = 26): HeatmapResult {
  const counts = new Map<number, number>();
  for (const ts of completions) {
    const day = startOfDay(new Date(ts));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  const todayStart = startOfDay(new Date(now));
  const start = addDays(startOfWeek(new Date(now)), -(weeks - 1) * 7);

  const days: HeatmapDay[] = [];
  let maxCount = 0;
  let activeDays = 0;
  for (let i = 0; i < weeks * 7; i++) {
    const date = addDays(start, i);
    const count = counts.get(date) ?? 0;
    if (count > maxCount) maxCount = count;
    if (count > 0) activeDays++;
    days.push({ date, count, future: date > todayStart });
  }

  const elapsedDays = Math.round((todayStart - start) / DAY_MS) + 1;
  return { days, weeks, maxCount, activeDays, elapsedDays };
}

/** Completion distribution by weekday (Mon-first) and hour-of-day. */
export function rhythmHistograms(completions: ReadonlyArray<number>): RhythmResult {
  const byWeekday = new Array(7).fill(0);
  const byHour = new Array(24).fill(0);
  for (const ts of completions) {
    const d = new Date(ts);
    byWeekday[weekdayIndex(d)]++;
    byHour[d.getHours()]++;
  }
  return {
    byWeekday,
    byHour,
    peakWeekday: argmax(byWeekday),
    peakHour: argmax(byHour),
    total: completions.length,
  };
}

/** Median lead time of completed items + age distribution of still-open items. */
export function cycleTimeStats(items: ReadonlyArray<WorkItem>, now: number): CycleTimeResult {
  const leads: number[] = [];
  let under1d = 0;
  let under1w = 0;
  let under1mo = 0;
  let over1mo = 0;

  for (const it of items) {
    if (it.completedAt !== undefined && it.completedAt >= it.createdAt) {
      leads.push(it.completedAt - it.createdAt);
    }
    const open = !it.done && it.completedAt === undefined;
    if (open) {
      const age = now - it.createdAt;
      if (age < DAY_MS) under1d++;
      else if (age < 7 * DAY_MS) under1w++;
      else if (age < 30 * DAY_MS) under1mo++;
      else over1mo++;
    }
  }

  return {
    medianLeadMs: leads.length ? median(leads) : null,
    completedCount: leads.length,
    openAgeBuckets: [
      { label: '< 1d', count: under1d },
      { label: '1–7d', count: under1w },
      { label: '1–4w', count: under1mo },
      { label: '> 1mo', count: over1mo },
    ],
  };
}

/** Follow-up engagement: discussions logged, active vs resolved, busiest topics. */
export function followUpStats(
  followUps: ReadonlyArray<{ title: string; archived?: boolean; discussionLog?: DiscussionEntry[] }>,
  rangeStart: number,
): FollowUpResult {
  let discussionsInRange = 0;
  let totalDiscussions = 0;
  let activeCount = 0;
  let resolvedCount = 0;
  const topics: TopicCount[] = [];

  for (const t of followUps) {
    if (t.archived) resolvedCount++;
    else activeCount++;
    const log = t.discussionLog ?? [];
    totalDiscussions += log.length;
    for (const entry of log) {
      if (entry.at >= rangeStart) discussionsInRange++;
    }
    if (log.length > 0) topics.push({ title: t.title, count: log.length });
  }

  topics.sort((a, b) => b.count - a.count);
  return {
    discussionsInRange,
    totalDiscussions,
    activeCount,
    resolvedCount,
    topTopics: topics.slice(0, 5),
  };
}

/**
 * Longest run of consecutive weekdays with ≥1 completion, anywhere in history.
 * Weekend completions don't extend a run (Fri→Mon counts as consecutive), matching
 * the weekday semantics of `computeStreak`.
 */
export function longestStreak(completionDates: ReadonlyArray<number>): number {
  const daySet = new Set<number>();
  for (const ts of completionDates) {
    const d = new Date(ts);
    if (!isWeekend(d)) daySet.add(startOfDay(d));
  }
  if (daySet.size === 0) return 0;

  let max = 0;
  for (const day of daySet) {
    if (daySet.has(prevWeekday(day))) continue; // not the start of a run
    let len = 0;
    let cur = day;
    while (daySet.has(cur)) {
      len++;
      cur = nextWeekday(cur);
    }
    if (len > max) max = len;
  }
  return max;
}

function rangeStartFor(range: InsightsRange, now: number): number {
  if (range === 'week') return addDays(startOfDay(new Date(now)), -6);
  if (range === 'month') return addDays(startOfDay(new Date(now)), -29);
  const d = new Date(startOfMonth(new Date(now)));
  d.setMonth(d.getMonth() - 11);
  return d.getTime();
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useInsights(range: InsightsRange): InsightsData | undefined {
  const [refreshKey, setRefreshKey] = useState(0);

  // Roll the "today" reference at midnight so the current bucket stays correct.
  useEffect(() => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const timeout = setTimeout(() => setRefreshKey((k) => k + 1), tomorrow.getTime() - now.getTime());
    return () => clearTimeout(timeout);
  }, [refreshKey]);

  return useLiveQuery(async () => {
    const now = Date.now();
    const [tasks, subtasks, lists] = await Promise.all([
      db.tasks.filter((t) => !t.deletedAt).toArray(),
      db.subtasks.filter((s) => !s.deletedAt).toArray(),
      db.taskLists.filter((l) => !l.deletedAt).toArray(),
    ]);

    const followUpListIds = new Set(lists.filter((l) => l.type === 'follow-ups').map((l) => l.id));
    const listNameById = new Map(lists.map((l) => [l.id, l.name]));

    // Follow-up topics are tracked separately; they're discussed/archived, not "completed".
    const followUpTasks = tasks.filter((t) => followUpListIds.has(t.listId));
    const workTasks = tasks.filter((t) => !followUpListIds.has(t.listId));

    const toItem = (t: { status: string; createdAt: number; completedAt?: number; updatedAt: number }): WorkItem => {
      const done = t.status === 'done';
      return { createdAt: t.createdAt, completedAt: t.completedAt ?? (done ? t.updatedAt : undefined), done };
    };
    const items: WorkItem[] = [...workTasks.map(toItem), ...subtasks.map(toItem)];

    const completions: number[] = [];
    for (const it of items) {
      if (it.done && it.completedAt !== undefined) completions.push(it.completedAt);
    }

    // Completions per work list (tasks only — subtasks have no direct list).
    const perListMap = new Map<string, number>();
    for (const t of workTasks) {
      if (t.status === 'done') perListMap.set(t.listId, (perListMap.get(t.listId) ?? 0) + 1);
    }
    const perList: TopicCount[] = [...perListMap.entries()]
      .map(([id, count]) => ({ title: listNameById.get(id) ?? 'Unknown', count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const flow = computeFlow(items, range, now);
    const heatmap = buildHeatmap(completions, now);
    const rhythm = rhythmHistograms(completions);
    const cycle = cycleTimeStats(items, now);
    const followUps = followUpStats(followUpTasks, rangeStartFor(range, now));

    const activeTasks = workTasks.filter((t) => t.status !== 'done').length;
    const hasAnyData = items.length > 0 || followUpTasks.length > 0;

    return {
      range,
      flow,
      heatmap,
      rhythm,
      cycle,
      followUps,
      streak: { current: computeStreak(completions), longest: longestStreak(completions) },
      totals: {
        completed: completions.length,
        activeTasks,
        followUpsActive: followUps.activeCount,
        perList,
      },
      hasAnyData,
    } satisfies InsightsData;
  }, [range, refreshKey]);
}
