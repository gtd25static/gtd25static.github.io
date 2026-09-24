// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { makeTask } from '../helpers/component-helpers';
import { DiscussionHistory } from '../../components/follow-ups/DiscussionHistory';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';

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
    const result = render(
      <>
        <ConfirmDialogContainer />
        <DiscussionHistory task={task} open onClose={() => {}} />
      </>,
    );
    return { task, user, ...result };
  }

  it('shows the note read-only until the pencil is clicked', () => {
    renderHistory();
    expect(screen.getByText('old note')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('old note')).not.toBeInTheDocument();
  });

  it('edits a note via the pencil and saves', async () => {
    const { user, task } = renderHistory();
    await user.click(screen.getByTitle('Edit this entry'));
    const textarea = screen.getByDisplayValue('old note');
    await user.clear(textarea);
    await user.type(textarea, 'edited note');
    await user.click(screen.getByText('Save'));

    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, {
      discussionLog: [expect.objectContaining({ id: 'd1', note: 'edited note' })],
    });
  });

  it('saves an edit with Enter', async () => {
    const { user, task } = renderHistory();
    await user.click(screen.getByTitle('Edit this entry'));
    const textarea = screen.getByDisplayValue('old note');
    await user.clear(textarea);
    await user.type(textarea, 'edited via enter{Enter}');

    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, {
      discussionLog: [expect.objectContaining({ id: 'd1', note: 'edited via enter' })],
    });
  });

  it('Shift+Enter inserts a newline in the edit instead of saving', async () => {
    const { user } = renderHistory();
    await user.click(screen.getByTitle('Edit this entry'));
    const textarea = screen.getByDisplayValue('old note');
    await user.clear(textarea);
    await user.type(textarea, 'line1{Shift>}{Enter}{/Shift}line2');

    expect(mockUpdateTask).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('line1\nline2');
  });

  it('cancel discards the edit without saving', async () => {
    const { user } = renderHistory();
    await user.click(screen.getByTitle('Edit this entry'));
    await user.type(screen.getByDisplayValue('old note'), ' changed');
    await user.click(screen.getByText('Cancel'));
    expect(mockUpdateTask).not.toHaveBeenCalled();
    expect(screen.getByText('old note')).toBeInTheDocument();
  });

  it('deletes an entry after confirmation', async () => {
    const { user, task } = renderHistory();
    await user.click(screen.getByTitle('Delete this entry'));
    expect(mockUpdateTask).not.toHaveBeenCalled(); // confirm gate
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, { discussionLog: [] });
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

  it('appends a new entry with Enter', async () => {
    const { user, task } = renderHistory();
    await user.type(screen.getByPlaceholderText('What was discussed?'), 'entry via enter{Enter}');

    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
    const [id, payload] = mockUpdateTask.mock.calls[0];
    expect(id).toBe(task.id);
    expect(payload.discussionLog[1]).toMatchObject({ note: 'entry via enter' });
  });

  it('shows an empty-state message and still allows adding', async () => {
    const { user } = renderHistory({ discussionLog: [] });
    expect(screen.getByText(/No discussions logged yet/)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('What was discussed?'), 'first one');
    await user.click(screen.getByText('Add entry'));
    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
  });

  it('stamps a new entry with the current time, not a fixed 12:00', async () => {
    const { user } = renderHistory();
    const before = Date.now();
    await user.type(screen.getByPlaceholderText('What was discussed?'), 'now-ish{Enter}');
    const after = Date.now();

    const entry = mockUpdateTask.mock.calls[0][1].discussionLog[1];
    expect(entry.at).toBeGreaterThanOrEqual(before);
    expect(entry.at).toBeLessThanOrEqual(after);
  });

  it('keeps the time of day when logging on a past date', async () => {
    const { user } = renderHistory();
    const input = document.querySelector('input[type="date"]') as HTMLInputElement;
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const iso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    fireEvent.change(input, { target: { value: iso } });
    const before = new Date();
    await user.click(screen.getByText('Add entry'));

    const at = new Date(mockUpdateTask.mock.calls[0][1].discussionLog[1].at);
    expect(at.getDate()).toBe(yesterday.getDate());
    // Time of day comes from "now" (within the test's run time), so it isn't pinned to noon.
    expect(Math.abs(at.getHours() * 60 + at.getMinutes() - (before.getHours() * 60 + before.getMinutes()))).toBeLessThanOrEqual(1);
  });

  it('lists entries newest first, breaking timestamp ties by the last one added', () => {
    const noon = new Date(2026, 8, 20, 12).getTime();
    renderHistory({
      discussionLog: [
        { id: 'a', at: noon - 86_400_000, note: 'day before' },
        { id: 'b', at: noon, note: 'first same-day' },
        { id: 'c', at: noon, note: 'second same-day' },
      ],
    });
    const notes = screen.getAllByText(/same-day|day before/).map((el) => el.textContent);
    expect(notes).toEqual(['second same-day', 'first same-day', 'day before']);
  });

  it('uses the day of adding, not of mounting, when the date was left untouched', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 8, 21, 23, 58));
      const { user } = renderHistory();
      // The card stays mounted past midnight; the user adds without touching the date.
      vi.setSystemTime(new Date(2026, 8, 22, 0, 3));
      await user.type(screen.getByPlaceholderText('What was discussed?'), 'after midnight{Enter}');

      const at = new Date(mockUpdateTask.mock.calls[0][1].discussionLog[1].at);
      expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([22, 0, 3]);
    } finally {
      vi.useRealTimers();
    }
  });
});
