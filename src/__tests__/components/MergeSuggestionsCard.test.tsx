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

  it('dismisses a suggestion', async () => {
    setGroups();
    const user = userEvent.setup();
    render(<MergeSuggestionsCard listId="l" listType="tasks" />);
    await user.click(screen.getByRole('button', { name: 'Dismiss suggestion' }));
    expect(screen.queryByText(/Comprar leche/)).not.toBeInTheDocument();
  });
});
