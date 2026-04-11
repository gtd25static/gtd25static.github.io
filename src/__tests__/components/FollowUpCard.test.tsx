// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { resetAppState, makeTask, makeTaskList } from '../helpers/component-helpers';
import { FollowUpCard } from '../../components/follow-ups/FollowUpCard';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';
import { ToastContainer } from '../../components/ui/Toast';

const fuList = makeTaskList({ id: 'fu-1', name: 'Follow Ups', type: 'follow-ups' });

vi.mock('../../hooks/use-task-lists', () => ({
  useTaskLists: () => [fuList],
}));

const mockUpdateTask = vi.fn();
const mockDeleteTask = vi.fn();
const mockRestoreTask = vi.fn();
const mockMoveTaskToList = vi.fn();

vi.mock('../../hooks/use-tasks', () => ({
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  deleteTask: (...args: unknown[]) => mockDeleteTask(...args),
  restoreTask: (...args: unknown[]) => mockRestoreTask(...args),
  moveTaskToList: (...args: unknown[]) => mockMoveTaskToList(...args),
}));

vi.mock('../../hooks/use-warning', () => ({
  toggleWarning: vi.fn(),
}));

vi.mock('../../hooks/use-follow-ups', () => ({
  isInCooldown: (t: { pingedAt?: number }) => Boolean(t.pingedAt),
  cooldownRemaining: () => 3600000,
  formatCooldown: () => '1h',
}));

describe('FollowUpCard', () => {
  beforeEach(() => {
    resetAppState();
    vi.clearAllMocks();
  });

  function renderCard(taskOverrides: Partial<Parameters<typeof makeTask>[1]> = {}) {
    const task = makeTask(fuList.id, { title: 'Follow up item', ...taskOverrides });
    const user = userEvent.setup();
    const result = render(
      <>
        <ConfirmDialogContainer />
        <ToastContainer />
        <FollowUpCard task={task} index={0} />
      </>,
    );
    return { task, user, ...result };
  }

  it('displays the task title', () => {
    renderCard({ title: 'Check on client' });
    expect(screen.getByText('Check on client')).toBeInTheDocument();
  });

  it('shows description if present', () => {
    renderCard({ description: 'Waiting for response' });
    expect(screen.getByText('Waiting for response')).toBeInTheDocument();
  });

  it('shows Archive button', () => {
    renderCard();
    expect(screen.getByTitle('Archive')).toBeInTheDocument();
  });

  it('calls updateTask with archived flag on archive click', async () => {
    const { user, task } = renderCard();
    await user.click(screen.getByTitle('Archive'));
    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, { archived: true });
  });

  it('shows Restore button when archived', () => {
    renderCard({ archived: true });
    expect(screen.getByTitle('Restore')).toBeInTheDocument();
  });

  it('shows Snooze button when not in cooldown', () => {
    renderCard();
    expect(screen.getByTitle('Snooze this follow-up')).toBeInTheDocument();
  });

  it('shows snooze options when Snooze is clicked', async () => {
    const { user } = renderCard();
    await user.click(screen.getByTitle('Snooze this follow-up'));
    expect(screen.getByText('12 hours')).toBeInTheDocument();
    expect(screen.getByText('1 week')).toBeInTheDocument();
    expect(screen.getByText('1 month')).toBeInTheDocument();
    expect(screen.getByText('Pick a date...')).toBeInTheDocument();
  });

  it('snoozes for 12h when option is clicked', async () => {
    const { user, task } = renderCard();
    await user.click(screen.getByTitle('Snooze this follow-up'));
    await user.click(screen.getByText('12 hours'));
    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, {
      pingedAt: expect.any(Number),
      pingCooldown: '12h',
    });
  });

  it('shows wake button when in cooldown', () => {
    renderCard({ pingedAt: Date.now() });
    expect(screen.getByTitle('Wake — remove snooze')).toBeInTheDocument();
  });

  it('clears pingedAt when wake is clicked', async () => {
    const { user, task } = renderCard({ pingedAt: Date.now() });
    await user.click(screen.getByTitle('Wake — remove snooze'));
    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, { pingedAt: undefined });
  });

  it('shows star button', () => {
    renderCard();
    expect(screen.getByTitle('Star')).toBeInTheDocument();
  });

  it('toggles star on click', async () => {
    const { user, task } = renderCard({ starred: false });
    await user.click(screen.getByTitle('Star'));
    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, { starred: true });
  });

  describe('inline title editing', () => {
    it('enters edit mode on double-click', async () => {
      const { user } = renderCard({ title: 'Editable title' });
      await user.dblClick(screen.getByText('Editable title'));
      expect(screen.getByDisplayValue('Editable title')).toBeInTheDocument();
    });

    it('saves on Enter', async () => {
      const { user, task } = renderCard({ title: 'Old' });
      await user.dblClick(screen.getByText('Old'));
      const input = screen.getByDisplayValue('Old');
      await user.clear(input);
      await user.type(input, 'New{Enter}');
      expect(mockUpdateTask).toHaveBeenCalledWith(task.id, { title: 'New' });
    });

    it('cancels on Escape', async () => {
      const { user } = renderCard({ title: 'Keep' });
      await user.dblClick(screen.getByText('Keep'));
      await user.keyboard('{Escape}');
      expect(screen.getByText('Keep')).toBeInTheDocument();
      expect(mockUpdateTask).not.toHaveBeenCalled();
    });
  });
});
