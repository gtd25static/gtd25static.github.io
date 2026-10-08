// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import '../setup-component';
import { renderWithUser, resetAppState } from '../helpers/component-helpers';
import { TopBanner } from '../../components/banners/TopBanner';
import { useAppState } from '../../stores/app-state';
import { useDueSoon } from '../../hooks/use-due-soon';

vi.mock('../../components/banners/MotivationBanner', () => ({ MotivationBanner: () => null }));
vi.mock('../../hooks/use-due-soon', () => ({ useDueSoon: vi.fn() }));

beforeEach(() => {
  resetAppState();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(useDueSoon).mockReturnValue([
    { type: 'task', id: 't1', taskId: 't1', listId: 'L1', title: 'Pay rent', dueDate: Date.now() },
    { type: 'subtask', id: 's1', taskId: 't2', listId: 'L2', title: 'Book flight', parentTitle: 'Trip', dueDate: Date.now() },
  ]);
});

describe('Due soon chips', () => {
  // A click toggled the task: on an open one it closed it. During a search the
  // results stayed on top, so the click seemed to do nothing.
  it('take you to the task: open (an open one stays open), focused, and out of a search', async () => {
    useAppState.setState({ searchQuery: 'rent' });
    useAppState.getState().ensureTaskExpanded('t1');
    const { user } = renderWithUser(<TopBanner />);

    await user.click(screen.getByText('Pay rent'));
    const s = useAppState.getState();
    expect(s.selectedListId).toBe('L1');
    expect(s.searchQuery).toBe('');
    expect(s.expandedTaskIds.has('t1')).toBe(true);
    expect(s.focusedItemId).toBe('t1');
  });

  it('a subtask opens its task and rings the subtask', async () => {
    const { user } = renderWithUser(<TopBanner />);
    await user.click(screen.getByText(/Book flight/));
    const s = useAppState.getState();
    expect(s.selectedListId).toBe('L2');
    expect(s.expandedTaskIds.has('t2')).toBe(true);
    expect(s.focusedItemId).toBe('s1');
  });
});
