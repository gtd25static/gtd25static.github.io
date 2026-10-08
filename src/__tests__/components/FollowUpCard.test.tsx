// @vitest-environment jsdom
import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { resetAppState, makeTask, makeTaskList } from '../helpers/component-helpers';
import { FollowUpCard } from '../../components/follow-ups/FollowUpCard';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';
import { ToastContainer } from '../../components/ui/Toast';
import { useAppState } from '../../stores/app-state';
import type { DiscussionEntry } from '../../db/models';

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

// The log each rendered card holds, for the mocked log edit to start from.
const cardLogs = new Map<string, DiscussionEntry[]>();

vi.mock('../../hooks/use-follow-ups', () => ({
  editDiscussionLog: async (id: string, edit: (log: DiscussionEntry[]) => DiscussionEntry[]) =>
    mockUpdateTask(id, { discussionLog: edit(cardLogs.get(id) ?? []) }),
  isInCooldown: (t: { pingedAt?: number }) => Boolean(t.pingedAt),
  cooldownRemaining: () => 3600000,
  formatCooldown: () => '1h',
  cadenceMs: () => 7 * 24 * 60 * 60 * 1000,
  cadenceLabel: () => 'every 1w',
  applyDiscussed: () => ({
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
    cardLogs.set(task.id, task.discussionLog ?? []);
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

  it('shows a History chip only when there is a discussion log', () => {
    renderCard({ discussionLog: [{ id: 'd1', at: Date.now(), note: 'talked to ops team' }] });
    expect(screen.getByRole('button', { name: 'History · 1' })).toBeInTheDocument();
  });

  it('hides the History chip when the log is empty', () => {
    renderCard();
    expect(screen.queryByRole('button', { name: /^History/ })).not.toBeInTheDocument();
  });

  describe('inline discussion log', () => {
    const log = [
      { id: 'd1', at: 1000, note: 'oldest note' },
      { id: 'd2', at: 2000, note: 'middle note' },
      { id: 'd3', at: 3000, note: 'newest note' },
    ];
    const box = () => screen.queryByPlaceholderText('What was discussed?');

    it('a click on the card opens it with the two newest entries; another click closes it', async () => {
      const { user } = renderCard({ title: 'Ask Ana', discussionLog: log });
      expect(box()).not.toBeInTheDocument();
      await user.click(screen.getByText('Ask Ana'));
      expect(box()).toBeInTheDocument();
      expect(screen.getByText('newest note')).toBeInTheDocument();
      expect(screen.getByText('middle note')).toBeInTheDocument();
      expect(screen.queryByText('oldest note')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show more (1)' })).toBeInTheDocument();
      await user.click(screen.getByText('Ask Ana'));
      expect(box()).not.toBeInTheDocument();
    });

    it('opens on a card without a log too, so the first note can be logged', async () => {
      const { user, task } = renderCard({ title: 'Ask Ana' });
      await user.click(screen.getByText('Ask Ana'));
      await user.type(box()!, 'first chat{Enter}');
      await waitFor(() => expect(mockUpdateTask).toHaveBeenCalled());
      expect(mockUpdateTask).toHaveBeenCalledWith(task.id, {
        discussionLog: [expect.objectContaining({ note: 'first chat' })],
      });
    });

    it('the History chip opens and closes it', async () => {
      const { user } = renderCard({ discussionLog: log });
      const chip = screen.getByRole('button', { name: 'History · 3' });
      expect(chip).toHaveAttribute('aria-expanded', 'false');
      await user.click(chip);
      expect(box()).toBeInTheDocument();
      expect(chip).toHaveAttribute('aria-expanded', 'true');
      await user.click(chip);
      expect(box()).not.toBeInTheDocument();
    });

    it('"History" in the ⋯ menu opens it (and leaves it open)', async () => {
      const { user, container } = renderCard();
      for (let i = 0; i < 2; i++) {
        await user.click(container.querySelector('[data-dropdown-trigger]')!);
        await user.click(screen.getByRole('button', { name: 'History' })); // no log yet, so no History chip: this is the menu's
        expect(box()).toBeInTheDocument();
      }
    });

    it('the card\'s buttons do their own job without opening it', async () => {
      const { user } = renderCard();
      await user.click(screen.getByTitle('Star'));
      await user.click(screen.getByTitle('Resolve — archive this follow-up'));
      await user.click(await screen.findByRole('button', { name: 'Cancel' }));
      await user.click(screen.getByRole('button', { name: 'Discussed' }));
      expect(box()).not.toBeInTheDocument();
    });

    it('clicks inside the Discussed popover or on the drag handle don\'t open it', async () => {
      const task = makeTask(fuList.id, { title: 'Ask Ana' });
      const user = userEvent.setup();
      const { container } = render(<FollowUpCard task={task} index={0} dragHandleProps={{}} />);
      await user.click(screen.getByRole('button', { name: 'Discussed' }));
      await user.click(screen.getByText('Snooze again in'));
      await user.click(container.querySelector('.cursor-grab')!);
      expect(box()).not.toBeInTheDocument();
    });

    it('clicks inside the open log don\'t close it', async () => {
      const { user } = renderCard({ title: 'Ask Ana', discussionLog: log });
      await user.click(screen.getByText('Ask Ana'));
      await user.click(screen.getByText('newest note'));
      await user.click(box()!);
      await user.click(screen.getByRole('button', { name: 'Show more (1)' }));
      expect(box()).toBeInTheDocument();
      expect(screen.getByText('oldest note')).toBeInTheDocument();
    });

    it('logging a note never snoozes', async () => {
      const { user, task } = renderCard({ title: 'Ask Ana', discussionLog: log });
      await user.click(screen.getByText('Ask Ana'));
      await user.type(box()!, 'spoke to ops');
      await user.click(screen.getByRole('button', { name: 'Log' }));
      await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledTimes(1));
      const [id, payload] = mockUpdateTask.mock.calls[0];
      expect(id).toBe(task.id);
      expect(Object.keys(payload)).toEqual(['discussionLog']);
      expect(payload.discussionLog).toHaveLength(4);
    });

    it('a snoozed card is no longer faded while its log is open', async () => {
      const { user, container } = renderCard({ title: 'Ask Ana', pingedAt: Date.now() });
      const card = container.querySelector('[data-focus-id]')!;
      expect(card.className).toContain('opacity-40');
      await user.click(screen.getByText('Ask Ana'));
      expect(card.className).not.toContain('opacity-40');
    });

    it('stays open across a remount (kept in the app state, like an expanded task)', async () => {
      const { user, unmount, task } = renderCard({ title: 'Ask Ana' });
      await user.click(screen.getByText('Ask Ana'));
      unmount();
      expect(useAppState.getState().expandedTaskIds.has(task.id)).toBe(true);
    });
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

  // Escape closed the popover and left the focus nowhere (on <body>).
  it('closing Discussed with Escape puts the focus back on its button', async () => {
    const { user } = renderCard();
    const chip = screen.getByRole('button', { name: 'Discussed' });
    await user.click(chip);
    expect(screen.getByRole('button', { name: 'Snooze' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Snooze' })).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
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

  describe('closed and open looks', () => {
    const log = [
      { id: 'd1', at: Date.now() - 3 * 86_400_000, note: 'older' },
      { id: 'd2', at: Date.now() - 2 * 86_400_000, note: 'Budget agreed\nsecond line' },
    ];

    it('closed, it says when the topic was last discussed and the first line of what was said', async () => {
      const { user } = renderCard({ title: 'Ask Ana', discussionLog: log });
      expect(screen.getByText('2d ago')).toBeInTheDocument();
      const preview = screen.getByText('Budget agreed');
      expect(preview.closest('[data-redact]')).not.toBeNull();
      expect(screen.queryByText(/second line/)).not.toBeInTheDocument();
      await user.click(screen.getByText('Ask Ana'));
      expect(screen.queryByText('2d ago')).not.toBeInTheDocument(); // the log itself shows it now
    });

    it('closed, it flags a note typed in its log and not logged yet', async () => {
      const { user, task } = renderCard({ title: 'Ask Ana' });
      expect(screen.queryByText('Unsent note')).not.toBeInTheDocument();
      await user.click(screen.getByText('Ask Ana'));
      await user.type(screen.getByPlaceholderText('What was discussed?'), 'half a thought');
      await user.click(screen.getByText('Ask Ana'));
      expect(screen.getByText('Unsent note')).toBeInTheDocument();
      expect(useAppState.getState().noteDrafts[task.id]).toBe('half a thought');
    });

    it('open, the card stands out from the list (accent border, no zebra tint)', async () => {
      const task = makeTask(fuList.id, { title: 'Ask Ana' });
      const user = userEvent.setup();
      const { container } = render(<FollowUpCard task={task} index={1} />);
      const card = container.querySelector('[data-focus-id]')!;
      expect(card.className).toContain('bg-zinc-50/70');
      await user.click(screen.getByText('Ask Ana'));
      expect(card.className).toContain('border-accent-300');
      expect(card.className).not.toContain('bg-zinc-50/70');
    });

    it('opened with a mouse, its note box is ready to type in; by touch it is not', () => {
      const task = makeTask(fuList.id, { title: 'Ask Ana' });
      render(<FollowUpCard task={task} index={0} />);
      const click = (pointerType: string) => act(() => {
        screen.getByText('Ask Ana').dispatchEvent(Object.assign(new MouseEvent('click', { bubbles: true }), { pointerType }));
      });
      click('touch');
      expect(screen.getByPlaceholderText('What was discussed?')).not.toHaveFocus();
      click('touch'); // closed again
      click('mouse');
      expect(screen.getByPlaceholderText('What was discussed?')).toHaveFocus();
    });
  });
});
