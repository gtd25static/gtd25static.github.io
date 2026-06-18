// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import type { InsightsData } from '../../hooks/use-insights';

const mockUseInsights = vi.fn();
vi.mock('../../hooks/use-insights', () => ({
  useInsights: (range: unknown) => mockUseInsights(range),
}));

import { InsightsView } from '../../components/insights/InsightsView';

function makeData(overrides: Partial<InsightsData> = {}): InsightsData {
  return {
    range: 'month',
    flow: {
      created: 10,
      completed: 12,
      net: 2,
      days: 30,
      avgCreatedPerDay: 0.33,
      avgCompletedPerDay: 0.4,
      buckets: [
        { start: 1, label: '1', created: 2, completed: 3 },
        { start: 2, label: '2', created: 1, completed: 0 },
      ],
    },
    heatmap: {
      days: Array.from({ length: 7 }, (_, i) => ({ date: i + 1, count: i === 2 ? 2 : 0, future: false })),
      weeks: 1,
      maxCount: 2,
      activeDays: 1,
      elapsedDays: 7,
    },
    rhythm: {
      byWeekday: [1, 2, 3, 0, 0, 0, 0],
      byHour: new Array(24).fill(0),
      peakWeekday: 2,
      peakHour: 9,
      total: 6,
    },
    cycle: {
      medianLeadMs: 2 * 24 * 60 * 60 * 1000,
      completedCount: 6,
      openAgeBuckets: [
        { label: '< 1d', count: 1 },
        { label: '1–7d', count: 2 },
        { label: '1–4w', count: 0 },
        { label: '> 1mo', count: 1 },
      ],
    },
    followUps: {
      discussionsInRange: 3,
      totalDiscussions: 5,
      activeCount: 1,
      resolvedCount: 1,
      topTopics: [{ title: 'Budget', count: 3 }],
    },
    streak: { current: 4, longest: 9 },
    totals: {
      completed: 42,
      activeTasks: 7,
      followUpsActive: 1,
      perList: [{ title: 'Work', count: 20 }],
    },
    hasAnyData: true,
    ...overrides,
  };
}

describe('InsightsView', () => {
  beforeEach(() => {
    mockUseInsights.mockReset();
  });

  it('shows a loading hint while data is undefined', () => {
    mockUseInsights.mockReturnValue(undefined);
    render(<InsightsView />);
    expect(screen.getByText(/crunching your numbers/i)).toBeInTheDocument();
  });

  it('shows an empty state when there is no activity', () => {
    mockUseInsights.mockReturnValue(makeData({ hasAnyData: false }));
    render(<InsightsView />);
    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
  });

  it('renders every dashboard section when data is present', () => {
    mockUseInsights.mockReturnValue(makeData());
    render(<InsightsView />);
    expect(screen.getByRole('heading', { name: 'Insights' })).toBeInTheDocument();
    expect(screen.getByText('Flow')).toBeInTheDocument();
    expect(screen.getByText('Consistency')).toBeInTheDocument();
    expect(screen.getByText('Rhythm')).toBeInTheDocument();
    expect(screen.getByText('Cycle time')).toBeInTheDocument();
    expect(screen.getByText('Where your work happens')).toBeInTheDocument();
    // a computed value surfaces (longest streak)
    expect(screen.getByText('9d')).toBeInTheDocument();
  });

  it('hides the Follow-ups section when the user has none', () => {
    mockUseInsights.mockReturnValue(
      makeData({
        followUps: { discussionsInRange: 0, totalDiscussions: 0, activeCount: 0, resolvedCount: 0, topTopics: [] },
      }),
    );
    render(<InsightsView />);
    // (the Totals section still has a "Follow-ups" stat label, so target the section heading)
    expect(screen.queryByRole('heading', { name: 'Follow-ups' })).not.toBeInTheDocument();
  });

  it('switches the active range and re-queries', async () => {
    mockUseInsights.mockReturnValue(makeData());
    const user = userEvent.setup();
    render(<InsightsView />);
    await user.click(screen.getByRole('button', { name: 'Week' }));
    expect(mockUseInsights).toHaveBeenCalledWith('week');
    expect(screen.getByText('Flow')).toBeInTheDocument();
  });
});
