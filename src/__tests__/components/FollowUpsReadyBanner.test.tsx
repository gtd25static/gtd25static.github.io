// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import '../setup-component';
import { resetAppState } from '../helpers/component-helpers';
import { FollowUpsReadyBanner } from '../../components/banners/FollowUpsReadyBanner';
import type { ReadyFollowUpItem } from '../../hooks/use-ready-follow-ups';

let items: ReadyFollowUpItem[] = [];
vi.mock('../../hooks/use-ready-follow-ups', () => ({
  useReadyFollowUps: () => items,
}));

describe('FollowUpsReadyBanner', () => {
  beforeEach(() => {
    resetAppState();
    items = [];
  });

  it('renders nothing when no follow-ups are ready', () => {
    const { container } = render(<FollowUpsReadyBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows ready follow-up titles', () => {
    items = [
      { taskId: 't1', listId: 'l1', title: 'Raise budget', listName: 'Leads' },
      { taskId: 't2', listId: 'l1', title: 'Check hiring', listName: 'Leads' },
    ];
    render(<FollowUpsReadyBanner />);
    expect(screen.getByText('Ready to discuss')).toBeInTheDocument();
    expect(screen.getByText('Raise budget')).toBeInTheDocument();
    expect(screen.getByText('Check hiring')).toBeInTheDocument();
  });

  it('caps the list and shows a +N more count', () => {
    items = Array.from({ length: 8 }, (_, i) => ({
      taskId: `t${i}`, listId: 'l1', title: `Topic ${i}`, listName: 'Leads',
    }));
    render(<FollowUpsReadyBanner />);
    expect(screen.getByText('+3 more')).toBeInTheDocument();
  });
});
