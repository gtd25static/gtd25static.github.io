// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { makeTask, resetAppState } from '../helpers/component-helpers';
import { DiscussionLog } from '../../components/follow-ups/DiscussionLog';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';
import { useAppState } from '../../stores/app-state';
import type { Task } from '../../db/models';

// The stored rows: each log change re-reads its follow-up from here, and the
// mocked updateTask writes back to it.
const stored = new Map<string, Task>();
vi.mock('../../db', () => ({
  db: { tasks: { get: async (id: string) => stored.get(id) } },
}));
const mockUpdateTask = vi.fn(async (id: string, updates: Partial<Task>) => {
  stored.set(id, { ...stored.get(id)!, ...updates });
});
vi.mock('../../hooks/use-tasks', () => ({
  updateTask: (...args: [string, Partial<Task>]) => mockUpdateTask(...args),
}));

/** Wait for the log change a click or Enter set off (it reads the stored row first). */
const saved = () => waitFor(() => expect(mockUpdateTask).toHaveBeenCalled());

describe('DiscussionLog (inline, editable)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored.clear();
    resetAppState();
  });

  function renderHistory(overrides = {}) {
    const task = makeTask('fu-1', {
      discussionLog: [{ id: 'd1', at: 1000, note: 'old note' }],
      ...overrides,
    });
    stored.set(task.id, task);
    const user = userEvent.setup();
    const result = render(
      <>
        <ConfirmDialogContainer />
        <DiscussionLog task={task} />
      </>,
    );
    return { task, user, ...result };
  }

  it('shows the note read-only until the pencil is clicked', () => {
    renderHistory();
    expect(screen.getByText('old note')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('old note')).not.toBeInTheDocument();
  });

  it('makes URLs in a note clickable, shortening long ones with …', () => {
    const long = 'https://example.com/a/very/long/path/that/goes/on/and/on?with=query&and=more';
    renderHistory({ discussionLog: [{ id: 'd1', at: 1000, note: `Spec at https://x.org/spec, notes: ${long}` }] });

    const short = screen.getByRole('link', { name: 'https://x.org/spec' });
    expect(short).toHaveAttribute('href', 'https://x.org/spec');
    expect(short).toHaveAttribute('target', '_blank');
    expect(short).toHaveAttribute('rel', 'noopener noreferrer');

    const shortened = screen.getByRole('link', { name: /^https:\/\/example\.com\/a\/very.*…$/ });
    expect(shortened).toHaveAttribute('href', long);
    expect(shortened).toHaveAttribute('title', long);
    expect(shortened.textContent!.length).toBeLessThanOrEqual(50);
    expect(screen.getByText(/^Spec at/)).toHaveTextContent(`Spec at https://x.org/spec, notes: ${shortened.textContent}`);
  });

  it('edits a note via the pencil and saves', async () => {
    const { user, task } = renderHistory();
    await user.click(screen.getByTitle('Edit this entry'));
    const textarea = screen.getByDisplayValue('old note');
    await user.clear(textarea);
    await user.type(textarea, 'edited note');
    await user.click(screen.getByText('Save'));
    await saved();

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
    await saved();

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
    await saved();
    expect(mockUpdateTask).toHaveBeenCalledWith(task.id, { discussionLog: [] });
  });

  it('appends a new entry', async () => {
    const { user, task } = renderHistory();
    await user.type(screen.getByPlaceholderText('What was discussed?'), 'a brand new entry');
    await user.click(screen.getByRole('button', { name: 'Log' }));
    await saved();

    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
    const [id, payload] = mockUpdateTask.mock.calls[0];
    expect(id).toBe(task.id);
    expect(payload.discussionLog).toHaveLength(2);
    // Stored oldest-first; the original entry is preserved.
    expect(payload.discussionLog![0]).toMatchObject({ id: 'd1' });
    expect(payload.discussionLog![1]).toMatchObject({ note: 'a brand new entry' });
  });

  it('appends a new entry with Enter', async () => {
    const { user, task } = renderHistory();
    await user.type(screen.getByPlaceholderText('What was discussed?'), 'entry via enter{Enter}');
    await saved();

    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
    const [id, payload] = mockUpdateTask.mock.calls[0];
    expect(id).toBe(task.id);
    expect(payload.discussionLog![1]).toMatchObject({ note: 'entry via enter' });
  });

  it('with an empty log shows just the box, and still allows adding', async () => {
    const { user } = renderHistory({ discussionLog: [] });
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('What was discussed?'), 'first one');
    await user.click(screen.getByRole('button', { name: 'Log' }));
    await saved();
    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
  });

  it('Log is disabled and Enter logs nothing while the note is blank', async () => {
    const { user } = renderHistory();
    expect(screen.getByRole('button', { name: 'Log' })).toBeDisabled();
    await user.type(screen.getByPlaceholderText('What was discussed?'), '   {Enter}');
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('logging only touches the log (never snoozes) and clears the box', async () => {
    const { user } = renderHistory();
    const box = screen.getByPlaceholderText('What was discussed?');
    await user.type(box, 'spoke to ops{Enter}');
    await saved();
    expect(Object.keys(mockUpdateTask.mock.calls[0][1])).toEqual(['discussionLog']);
    expect(box).toHaveValue('');
  });

  it('Shift+Enter in the box inserts a newline instead of logging', async () => {
    const { user } = renderHistory();
    const box = screen.getByPlaceholderText('What was discussed?');
    await user.type(box, 'line1{Shift>}{Enter}{/Shift}line2');
    expect(mockUpdateTask).not.toHaveBeenCalled();
    expect(box).toHaveValue('line1\nline2');
  });

  it('stamps a new entry with the current time, not a fixed 12:00', async () => {
    const { user } = renderHistory();
    const before = Date.now();
    await user.type(screen.getByPlaceholderText('What was discussed?'), 'now-ish{Enter}');
    const after = Date.now();
    await saved();

    const entry = mockUpdateTask.mock.calls[0][1].discussionLog![1];
    expect(entry.at).toBeGreaterThanOrEqual(before);
    expect(entry.at).toBeLessThanOrEqual(after);
  });

  it('lists entries newest first, breaking timestamp ties by the last one added', async () => {
    const noon = new Date(2026, 8, 20, 12).getTime();
    const { user } = renderHistory({
      discussionLog: [
        { id: 'a', at: noon - 86_400_000, note: 'day before' },
        { id: 'b', at: noon, note: 'first same-day' },
        { id: 'c', at: noon, note: 'second same-day' },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Show more (1)' }));
    const notes = screen.getAllByText(/same-day|day before/).map((el) => el.textContent);
    expect(notes).toEqual(['second same-day', 'first same-day', 'day before']);
  });

  describe('only the newest two until "Show more"', () => {
    const log = [1, 2, 3, 4, 5].map((n) => ({ id: `e${n}`, at: n * 1000, note: `note ${n}` }));
    const visibleNotes = () => screen.getAllByText(/^note \d$/).map((el) => el.textContent);

    it('shows the two newest and how many more there are', () => {
      renderHistory({ discussionLog: log });
      expect(visibleNotes()).toEqual(['note 5', 'note 4']);
      expect(screen.getByRole('button', { name: 'Show more (3)' })).toBeInTheDocument();
    });

    it('"Show more" reveals all of them, "Show less" goes back to two', async () => {
      const { user } = renderHistory({ discussionLog: log });
      await user.click(screen.getByRole('button', { name: 'Show more (3)' }));
      expect(visibleNotes()).toEqual(['note 5', 'note 4', 'note 3', 'note 2', 'note 1']);
      await user.click(screen.getByRole('button', { name: 'Show less' }));
      expect(visibleNotes()).toEqual(['note 5', 'note 4']);
    });

    it('has no "Show more" with two entries or fewer', () => {
      renderHistory({ discussionLog: log.slice(0, 2) });
      expect(visibleNotes()).toEqual(['note 2', 'note 1']);
      expect(screen.queryByRole('button', { name: /Show more|Show less/ })).not.toBeInTheDocument();
    });

    it('a new note goes on top and pushes the oldest shown one behind "Show more"', async () => {
      const { user, rerender, task } = renderHistory({ discussionLog: log.slice(0, 2) });
      await user.type(screen.getByPlaceholderText('What was discussed?'), 'note 9{Enter}');
      await saved();
      const newLog = mockUpdateTask.mock.calls[0][1].discussionLog;
      rerender(
        <>
          <ConfirmDialogContainer />
          <DiscussionLog task={{ ...task, discussionLog: newLog }} />
        </>,
      );
      expect(visibleNotes()).toEqual(['note 9', 'note 2']);
      expect(screen.getByRole('button', { name: 'Show more (1)' })).toBeInTheDocument();
    });
  });

  // Two notes in quick succession each started from the log as last rendered:
  // the second write dropped the first.
  it('keeps both of two notes logged one right after the other', async () => {
    const { user, task } = renderHistory();
    const box = screen.getByPlaceholderText('What was discussed?');
    await user.type(box, 'first{Enter}');
    await user.type(box, 'second{Enter}'); // the card still shows the old log
    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledTimes(2));
    expect(stored.get(task.id)!.discussionLog!.map((e) => e.note)).toEqual(['old note', 'first', 'second']);
  });

  it('keeps an unsent note when the log closes and opens again, until it is logged', async () => {
    const first = renderHistory();
    await first.user.type(screen.getByPlaceholderText('What was discussed?'), 'half a thought');
    first.unmount();

    render(<DiscussionLog task={first.task} />);
    const box = screen.getByPlaceholderText('What was discussed?');
    expect(box).toHaveValue('half a thought');
    await userEvent.setup().type(box, '{Enter}');
    await saved();
    expect(box).toHaveValue('');
    expect(useAppState.getState().noteDrafts[first.task.id]).toBeUndefined();
  });

  it('takes the focus when asked to (opened from the keyboard or with a mouse)', () => {
    const task = makeTask('fu-1');
    useAppState.getState().setNoteFocusTaskId(task.id);
    render(<DiscussionLog task={task} />);
    expect(screen.getByPlaceholderText('What was discussed?')).toHaveFocus();
    expect(useAppState.getState().noteFocusTaskId).toBeNull();
  });

  it('is headed as the discussion log, with its size', () => {
    renderHistory();
    expect(screen.getByRole('heading', { name: 'Discussion log · 1' })).toBeInTheDocument();
  });
});
