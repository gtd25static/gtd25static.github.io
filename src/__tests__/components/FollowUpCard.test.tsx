// @vitest-environment jsdom
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { resetAppState, makeTask, makeTaskList } from '../helpers/component-helpers';
import { FollowUpCard } from '../../components/follow-ups/FollowUpCard';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';
import { ToastContainer } from '../../components/ui/Toast';

const fuList = makeTaskList({ id: 'fu-1', name: 'Follow Ups', type: 'follow-ups' });
const workList = makeTaskList({ id: 'work', name: 'Work', type: 'tasks' });

vi.mock('../../hooks/use-task-lists', () => ({
  useTaskLists: () => [fuList, workList],
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
  cadenceLabel: () => 'every 1w',
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

  it('re-snoozes via Snooze in the "Discussed" popover', async () => {
    const { user, task } = renderCard();
    await user.click(screen.getByText('Discussed'));
    await user.click(screen.getByText('Snooze'));
    expect(mockUpdateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
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
    expect(await screen.findByText('talked to ops team')).toBeInTheDocument();
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

  // The create form was fixed first; the edit dialog let you switch it on too.
  it('the edit dialog offers no recurrence', async () => {
    const { user, container } = renderCard();
    await user.click(container.querySelector('[data-dropdown-trigger]')!);
    await user.click(screen.getByText('Edit'));
    expect(await screen.findByLabelText('Due date')).toBeInTheDocument();
    expect(screen.queryByText('Recurring')).toBeNull();
  });

  it('saving the edit dialog drops a recurrence the follow-up picked up earlier', async () => {
    const { user, container, task } = renderCard({
      recurrenceType: 'time-based', recurrenceInterval: 1, recurrenceUnit: 'weeks', nextOccurrence: Date.now() + 1000,
    });
    await user.click(container.querySelector('[data-dropdown-trigger]')!);
    await user.click(screen.getByText('Edit'));
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      recurrenceType: undefined, recurrenceInterval: undefined, recurrenceUnit: undefined, nextOccurrence: undefined,
    }));
    const [, payload] = mockUpdateTask.mock.calls[0];
    expect('recurrenceType' in payload).toBe(true); // cleared, not just left out
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

  describe('context menu', () => {
    it('turns the follow-up into a task via "Send to task list"', async () => {
      mockMoveTaskToList.mockResolvedValue(true);
      const { user, task } = renderCard({ title: 'Menu follow-up' });
      fireEvent.contextMenu(screen.getByText('Menu follow-up'));
      await user.hover(screen.getByText('Send to task list'));
      fireEvent.click(screen.getByText('Work'));
      expect(mockMoveTaskToList).toHaveBeenCalledWith(task.id, 'work');
      expect(await screen.findByText('Moved to Work')).toBeInTheDocument();
    });
  });
});
