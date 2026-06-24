// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { makeTask } from '../helpers/component-helpers';
import { MergeModal } from '../../components/tasks/MergeModal';
import type { MergeSuggestionGroup } from '../../hooks/use-merge-suggestions';

const mockMerge = vi.fn(async (..._args: unknown[]) => ({ survivor: {}, sources: [], reparented: [] }));

vi.mock('../../hooks/use-merge', () => ({
  mergeTasks: (...args: unknown[]) => mockMerge(...args),
  unmergeTasks: vi.fn(),
  combineTaskContent: () => ({}),
}));

function makeGroup(): MergeSuggestionGroup {
  return {
    signature: 't1|t2|t3',
    score: 0.9,
    tasks: [
      makeTask('l', { id: 't1', title: 'Comprar leche' }),
      makeTask('l', { id: 't2', title: 'comprar leche', description: 'lots of detail here' }),
      makeTask('l', { id: 't3', title: 'COMPRAR leche' }),
    ],
  };
}

function renderModal() {
  const onClose = vi.fn();
  const onMerged = vi.fn();
  const user = userEvent.setup();
  render(<MergeModal group={makeGroup()} listType="tasks" onClose={onClose} onMerged={onMerged} />);
  return { user, onClose, onMerged };
}

describe('MergeModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults the survivor to the most complete entry', () => {
    renderModal();
    // t2 has a description -> it is the default "Keep".
    const t2Radio = screen.getByRole('radio', { name: 'Keep "comprar leche"' });
    expect(t2Radio).toBeChecked();
  });

  it('merges into the chosen survivor with the other ids as sources', async () => {
    const { user, onMerged } = renderModal();
    await user.click(screen.getByRole('button', { name: /merge 3/i }));
    await waitFor(() => expect(mockMerge).toHaveBeenCalledWith('t2', ['t1', 't3']));
    expect(onMerged).toHaveBeenCalled();
  });

  it('respects a survivor change', async () => {
    const { user } = renderModal();
    await user.click(screen.getByRole('radio', { name: 'Keep "Comprar leche"' })); // t1
    await user.click(screen.getByRole('button', { name: /merge 3/i }));
    await waitFor(() => expect(mockMerge).toHaveBeenCalledWith('t1', ['t2', 't3']));
  });

  it('disables merging when fewer than 2 entries remain', async () => {
    const { user } = renderModal();
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(screen.getByRole('button', { name: /merge 1/i })).toBeDisabled();
    expect(screen.getByText('Select at least 2 entries')).toBeInTheDocument();
  });
});
