import {
  computeFlow,
  buildHeatmap,
  rhythmHistograms,
  cycleTimeStats,
  followUpStats,
  longestStreak,
} from '../../hooks/use-insights';

const DAY = 24 * 60 * 60 * 1000;

function dayTs(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00`).getTime();
}

describe('computeFlow', () => {
  it('week range: 7 daily buckets with correct in/out, net and averages', () => {
    const now = dayTs('2026-03-18'); // Wednesday
    const items = [
      { createdAt: dayTs('2026-03-18'), completedAt: dayTs('2026-03-18') }, // in + out today
      { createdAt: dayTs('2026-03-16') }, // in only (Monday)
      { createdAt: dayTs('2026-03-08'), completedAt: dayTs('2026-03-17') }, // created outside window, out on Tue
    ];
    const flow = computeFlow(items, 'week', now);

    expect(flow.buckets).toHaveLength(7);
    expect(flow.days).toBe(7);
    expect(flow.created).toBe(2); // 18th + 16th (8th is outside the 7-day window)
    expect(flow.completed).toBe(2); // 18th + 17th
    expect(flow.net).toBe(0);
    expect(flow.avgCreatedPerDay).toBeCloseTo(2 / 7);
    // buckets ordered oldest→newest: index 6 = today (18th), 5 = 17th, 4 = 16th
    expect(flow.buckets[6]).toMatchObject({ created: 1, completed: 1 });
    expect(flow.buckets[5]).toMatchObject({ completed: 1 });
    expect(flow.buckets[4]).toMatchObject({ created: 1 });
  });

  it('year range: 12 monthly buckets honouring the trailing window', () => {
    const now = dayTs('2026-06-18');
    const items = [
      { createdAt: dayTs('2026-06-01'), completedAt: dayTs('2026-06-10') }, // current month
      { createdAt: dayTs('2025-08-15') }, // ~10 months ago → in window
      { createdAt: dayTs('2025-01-01') }, // before window start (Jul 2025) → excluded
    ];
    const flow = computeFlow(items, 'year', now);

    expect(flow.buckets).toHaveLength(12);
    expect(flow.created).toBe(2);
    expect(flow.completed).toBe(1);
    expect(flow.buckets[11]).toMatchObject({ created: 1, completed: 1 }); // June 2026
  });
});

describe('buildHeatmap', () => {
  it('builds a Monday-aligned grid, flags future days, and counts activity', () => {
    const now = dayTs('2026-03-18'); // Wednesday
    const completions = [
      new Date('2026-03-16T09:00:00').getTime(), // Mon
      new Date('2026-03-16T15:00:00').getTime(), // Mon (→ count 2)
      new Date('2026-03-17T10:00:00').getTime(), // Tue
    ];
    const hm = buildHeatmap(completions, now, 2);

    expect(hm.days).toHaveLength(14);
    expect(hm.weeks).toBe(2);
    expect(hm.maxCount).toBe(2);
    expect(hm.activeDays).toBe(2);
    expect(hm.days.some((d) => d.count === 2)).toBe(true);
    // Thu–Sun of the current week lie after "today" (Wed 18th)
    expect(hm.days.filter((d) => d.future)).toHaveLength(4);
  });
});

describe('rhythmHistograms', () => {
  it('buckets by weekday (Mon-first) and hour, identifying peaks', () => {
    const c = [
      new Date('2026-03-16T09:00:00').getTime(), // Mon 9am
      new Date('2026-03-16T09:30:00').getTime(), // Mon 9am
      new Date('2026-03-17T14:00:00').getTime(), // Tue 2pm
    ];
    const r = rhythmHistograms(c);

    expect(r.byWeekday[0]).toBe(2); // Monday
    expect(r.byWeekday[1]).toBe(1); // Tuesday
    expect(r.byHour[9]).toBe(2);
    expect(r.byHour[14]).toBe(1);
    expect(r.peakWeekday).toBe(0);
    expect(r.peakHour).toBe(9);
    expect(r.total).toBe(3);
  });

  it('returns null peaks when there are no completions', () => {
    const r = rhythmHistograms([]);
    expect(r.peakWeekday).toBeNull();
    expect(r.peakHour).toBeNull();
    expect(r.total).toBe(0);
  });
});

describe('cycleTimeStats', () => {
  it('computes median lead time and open-task age buckets', () => {
    const now = dayTs('2026-03-18');
    const items = [
      { createdAt: now - 2 * DAY, completedAt: now - 1 * DAY, done: true }, // lead 1d
      { createdAt: now - 5 * DAY, completedAt: now - 1 * DAY, done: true }, // lead 4d
      { createdAt: now - 10 * DAY, completedAt: now - 4 * DAY, done: true }, // lead 6d
      { createdAt: now - 2 * 60 * 60 * 1000, done: false }, // open < 1d
      { createdAt: now - 3 * DAY, done: false }, // open 1–7d
      { createdAt: now - 40 * DAY, done: false }, // open > 1mo
    ];
    const c = cycleTimeStats(items, now);

    expect(c.completedCount).toBe(3);
    expect(c.medianLeadMs).toBe(4 * DAY); // median of [1d, 4d, 6d]
    const byLabel = Object.fromEntries(c.openAgeBuckets.map((b) => [b.label, b.count]));
    expect(byLabel['< 1d']).toBe(1);
    expect(byLabel['1–7d']).toBe(1);
    expect(byLabel['1–4w']).toBe(0);
    expect(byLabel['> 1mo']).toBe(1);
  });

  it('reports a null median when nothing is completed', () => {
    const now = dayTs('2026-03-18');
    const c = cycleTimeStats([{ createdAt: now - DAY, done: false }], now);
    expect(c.medianLeadMs).toBeNull();
    expect(c.completedCount).toBe(0);
  });
});

describe('followUpStats', () => {
  it('counts discussions in range, active vs resolved, and ranks topics', () => {
    const now = dayTs('2026-03-18');
    const rangeStart = now - 7 * DAY;
    const followUps = [
      {
        title: 'Budget',
        archived: false,
        discussionLog: [
          { id: 'a', at: now - 1 * DAY },
          { id: 'b', at: now - 2 * DAY },
          { id: 'c', at: now - 30 * DAY }, // outside range
        ],
      },
      { title: 'Hiring', archived: true, discussionLog: [{ id: 'd', at: now - 3 * DAY }] },
      { title: 'Untouched', archived: false }, // no discussions
    ];
    const r = followUpStats(followUps, rangeStart);

    expect(r.activeCount).toBe(2); // Budget + Untouched
    expect(r.resolvedCount).toBe(1); // Hiring
    expect(r.totalDiscussions).toBe(4);
    expect(r.discussionsInRange).toBe(3); // Budget(2 recent) + Hiring(1)
    expect(r.topTopics).toEqual([
      { title: 'Budget', count: 3 },
      { title: 'Hiring', count: 1 },
    ]); // Untouched (0) excluded
  });

  it('caps the topic ranking at five entries', () => {
    const topics = Array.from({ length: 8 }, (_, i) => ({
      title: `T${i}`,
      discussionLog: Array.from({ length: i + 1 }, (_, j) => ({ id: `${i}-${j}`, at: j })),
    }));
    const r = followUpStats(topics, 0);
    expect(r.topTopics).toHaveLength(5);
    expect(r.topTopics[0].title).toBe('T7'); // most discussions first
  });
});

describe('longestStreak', () => {
  it('finds the longest consecutive-weekday run, bridging weekends', () => {
    const dates = [
      dayTs('2026-03-02'), // Mon ┐
      dayTs('2026-03-03'), // Tue │
      dayTs('2026-03-04'), // Wed ├ run of 5
      dayTs('2026-03-05'), // Thu │
      dayTs('2026-03-06'), // Fri ┘
      dayTs('2026-03-12'), // Thu ┐
      dayTs('2026-03-13'), // Fri ├ run of 3 (bridges the weekend to Mon)
      dayTs('2026-03-16'), // Mon ┘
    ];
    expect(longestStreak(dates)).toBe(5);
  });

  it('ignores weekend-only completions', () => {
    expect(longestStreak([dayTs('2026-03-14'), dayTs('2026-03-15')])).toBe(0); // Sat + Sun
  });

  it('returns 0 for no completions', () => {
    expect(longestStreak([])).toBe(0);
  });
});
