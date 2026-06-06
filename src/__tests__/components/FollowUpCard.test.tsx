// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
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
  cadenceMs: () => 7 * 24 * 60 * 60 * 1000,
  isAwake: () => true,
  applyDiscussed: (_t: unknown, note?: string) => ({
    discussionLog: [{ id: 'x', at: 1, note }],
    pingedAt: 1,
    pingCooldown: 'custom',
    pingCooldownUntil: 2,
  }),
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

  it('has no one-tap archive/clock button (misclick fix)', () => {
    renderCard();
    expect(screen.queryByTitle('Archive')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Restore')).not.toBeInTheDocument();
  });

  it('logs a discussion and re-snoozes when "Discussed" is confirmed', async () => {
    const { user, task } = renderCard();
    await user.click(screen.getByText('Discussed'));
    await user.click(screen.getByText('Log & snooze'));
    expect(mockUpdateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        discussionLog: expect.any(Array),
        pingCooldown: 'custom',
        pingCooldownUntil: expect.any(Number),
      }),
    );
  });

  it('resolving (visible chip) is confirm-gated and sets archived', async () => {
    const { user, task } = renderCard();
    await user.click(screen.getByTitle('Resolve — archive this follow-up'));
    // Confirmation must appear before anything is archived.
    expect(mockUpdateTask).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }));
    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, { archived: true });
  });

  it('shows Unresolve (no confirm) and reopens an archived item', async () => {
    const { user, task } = renderCard({ archived: true });
    expect(screen.queryByTitle('Resolve — archive this follow-up')).not.toBeInTheDocument();
    await user.click(screen.getByTitle('Unresolve — move back to active'));
    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, { archived: false });
  });

  it('shows a History chip only when there is a discussion log', async () => {
    const { user } = renderCard({
      discussionLog: [{ id: 'd1', at: Date.now(), note: 'talked to ops team' }],
    });
    await user.click(screen.getByTitle('View and edit discussion history'));
    expect(await screen.findByDisplayValue('talked to ops team')).toBeInTheDocument();
  });

  it('hides the History chip when the log is empty', () => {
    renderCard();
    expect(screen.queryByTitle('View and edit discussion history')).not.toBeInTheDocument();
  });

  it('does not render a standalone Snooze button', () => {
    renderCard();
    expect(screen.queryByTitle('Snooze this follow-up')).not.toBeInTheDocument();
  });

  it('shows an Unsnooze chip when in cooldown', () => {
    renderCard({ pingedAt: Date.now() });
    expect(screen.getByTitle('Unsnooze — remove snooze')).toBeInTheDocument();
  });

  it('clears the ping fields when Unsnooze is clicked', async () => {
    const { user, task } = renderCard({ pingedAt: Date.now() });
    await user.click(screen.getByTitle('Unsnooze — remove snooze'));
    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, {
      pingedAt: undefined,
      pingCooldown: undefined,
      pingCooldownCustomMs: undefined,
      pingCooldownUntil: undefined,
    });
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
