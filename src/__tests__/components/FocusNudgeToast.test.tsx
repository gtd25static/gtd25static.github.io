// @vitest-environment jsdom
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';
import { FocusNudgeToast } from '../../components/banners/FocusNudgeToast';
import { dismissFocusNudge, showFocusNudge } from '../../stores/focus-nudge';
import type { NudgeContent } from '../../lib/nudges';
import { focusTask } from '../../hooks/use-focus';

vi.mock('../../hooks/use-focus', () => ({
  focusTask: vi.fn(),
}));

const nudge: NudgeContent = {
  kind: 'overdue',
  itemType: 'task',
  title: 'Overdue task',
  body: '"Pay rent" is overdue.',
  taskId: 'task-1',
  listId: 'list-1',
  taskTitle: 'Pay rent',
  dueDate: Date.now() - 86_400_000,
};

function renderOpenToast() {
  act(() => showFocusNudge(nudge));
  return render(<FocusNudgeToast />);
}

describe('FocusNudgeToast', () => {
  beforeEach(() => {
    vi.mocked(focusTask).mockResolvedValue();
    act(() => dismissFocusNudge());
  });

  it('renders the centered nudge dialog', () => {
    renderOpenToast();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Pay rent')).toBeInTheDocument();
  });

  it('dismisses from the Dismiss button', async () => {
    const user = userEvent.setup();
    renderOpenToast();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('dismisses from a backdrop click', () => {
    renderOpenToast();
    const dialog = screen.getByRole('dialog');

    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not dismiss when clicking inside the prompt', () => {
    renderOpenToast();
    const title = screen.getByText('Pay rent');

    fireEvent.mouseDown(title);
    fireEvent.click(title);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('dismisses on Escape cancel', () => {
    renderOpenToast();
    const dialog = screen.getByRole('dialog');

    fireEvent(dialog, new Event('cancel', { cancelable: true }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('focuses the suggested task and closes', async () => {
    const user = userEvent.setup();
    renderOpenToast();

    await user.click(screen.getByRole('button', { name: 'Focus' }));

    await waitFor(() => expect(focusTask).toHaveBeenCalledWith('task-1'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
