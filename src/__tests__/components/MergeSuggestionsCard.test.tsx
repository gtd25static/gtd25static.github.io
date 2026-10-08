// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { makeTask } from '../helpers/component-helpers';
import { MergeSuggestionsCard } from '../../components/tasks/MergeSuggestionsCard';
import type { MergeSuggestionGroup } from '../../hooks/use-merge-suggestions';

const h = vi.hoisted(() => ({ groups: [] as MergeSuggestionGroup[] }));

vi.mock('../../hooks/use-merge-suggestions', () => ({
  useMergeSuggestions: () => h.groups,
}));

const mockMarkNotDuplicates = vi.fn();
vi.mock('../../hooks/use-task-lists', () => ({
  markNotDuplicates: (...args: unknown[]) => mockMarkNotDuplicates(...args),
}));

// Stub the modal so this test stays at the banner level.
vi.mock('../../components/tasks/MergeModal', () => ({
  MergeModal: () => <div data-testid="merge-modal" />,
}));

function setGroups() {
  h.groups = [
    {
      signature: 't1|t2',
      score: 0.9,
      tasks: [
        makeTask('l', { id: 't1', title: 'Comprar leche' }),
        makeTask('l', { id: 't2', title: 'comprar leche' }),
      ],
    },
  ];
}

describe('MergeSuggestionsCard', () => {
  beforeEach(() => {
    h.groups = [];
    vi.clearAllMocks();
  });

  it('renders nothing when there are no suggestions', () => {
    const { container } = render(<MergeSuggestionsCard listId="l" listType="tasks" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the group titles and a Review action', () => {
    setGroups();
    render(<MergeSuggestionsCard listId="l" listType="tasks" />);
    expect(screen.getByText(/Possible duplicates/i)).toBeInTheDocument();
    expect(screen.getByText(/Comprar leche/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });

  it('opens the merge modal on Review', async () => {
    setGroups();
    const user = userEvent.setup();
    render(<MergeSuggestionsCard listId="l" listType="tasks" />);
    expect(screen.queryByTestId('merge-modal')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByTestId('merge-modal')).toBeInTheDocument();
  });

  // The dialog vanished when its group did (say, one of them was completed on
  // another device) but stayed armed, and popped up with stale tasks as soon as
  // any suggestion showed again.
  it('closes Review when its group goes away, and does not bring it back later', async () => {
    setGroups();
    const user = userEvent.setup();
    const { rerender } = render(<MergeSuggestionsCard listId="l" listType="tasks" />);
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByTestId('merge-modal')).toBeInTheDocument();

    h.groups = [];
    rerender(<MergeSuggestionsCard listId="l" listType="tasks" />);
    expect(screen.queryByTestId('merge-modal')).not.toBeInTheDocument();
    setGroups();
    rerender(<MergeSuggestionsCard listId="l" listType="tasks" />);
    expect(screen.getByText(/Comprar leche/)).toBeInTheDocument();
    expect(screen.queryByTestId('merge-modal')).not.toBeInTheDocument();
  });

  // A × only hid it for the session, so the same pairs came back again and again.
  it('"Not duplicates" keeps the group apart for good and hides it; there is no ×', async () => {
    setGroups();
    const user = userEvent.setup();
    render(<MergeSuggestionsCard listId="l" listType="tasks" />);
    expect(screen.queryByRole('button', { name: 'Dismiss suggestion' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Not duplicates' }));
    expect(mockMarkNotDuplicates).toHaveBeenCalledWith('l', ['t1', 't2']);
    expect(screen.queryByText(/Comprar leche/)).not.toBeInTheDocument();
  });
});
