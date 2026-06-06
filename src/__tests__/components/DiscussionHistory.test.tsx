// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { makeTask } from '../helpers/component-helpers';
import { DiscussionHistory } from '../../components/follow-ups/DiscussionHistory';

const mockUpdateTask = vi.fn();
vi.mock('../../hooks/use-tasks', () => ({
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
}));

describe('DiscussionHistory (editable)', () => {
  beforeEach(() => vi.clearAllMocks());

  function renderHistory(overrides = {}) {
    const task = makeTask('fu-1', {
      discussionLog: [{ id: 'd1', at: 1000, note: 'old note' }],
      ...overrides,
    });
    const user = userEvent.setup();
    const result = render(<DiscussionHistory task={task} open onClose={() => {}} />);
    return { task, user, ...result };
  }

  it('saves an edited note on blur', async () => {
    const { user, task } = renderHistory();
    const textarea = screen.getByDisplayValue('old note');
    await user.clear(textarea);
    await user.type(textarea, 'edited note');
    await user.tab(); // blur

    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, {
      discussionLog: [expect.objectContaining({ id: 'd1', note: 'edited note' })],
    });
  });

  it('does not save when the note is unchanged', async () => {
    const { user } = renderHistory();
    const textarea = screen.getByDisplayValue('old note');
    await user.click(textarea);
    await user.tab();
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('appends a new entry', async () => {
    const { user, task } = renderHistory();
    await user.type(screen.getByPlaceholderText('What was discussed?'), 'a brand new entry');
    await user.click(screen.getByText('Add entry'));

    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
    const [id, payload] = mockUpdateTask.mock.calls[0];
    expect(id).toBe(task.id);
    expect(payload.discussionLog).toHaveLength(2);
    // Stored oldest-first; the original entry is preserved.
    expect(payload.discussionLog[0]).toMatchObject({ id: 'd1' });
    expect(payload.discussionLog[1]).toMatchObject({ note: 'a brand new entry' });
  });

  it('shows an empty-state message and still allows adding', async () => {
    const { user } = renderHistory({ discussionLog: [] });
    expect(screen.getByText(/No discussions logged yet/)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('What was discussed?'), 'first one');
    await user.click(screen.getByText('Add entry'));
    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
  });
});
