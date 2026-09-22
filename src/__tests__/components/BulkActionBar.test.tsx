// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { resetAppState, makeTaskList } from '../helpers/component-helpers';
import { useAppState } from '../../stores/app-state';
import { BulkActionBar } from '../../components/tasks/BulkActionBar';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';
import { ToastContainer } from '../../components/ui/Toast';

const workList = makeTaskList({ id: 'work', name: 'Work', type: 'tasks' });
const personalList = makeTaskList({ id: 'personal', name: 'Personal', type: 'tasks' });
const peopleList = makeTaskList({ id: 'people', name: 'People', type: 'follow-ups' });

vi.mock('../../hooks/use-task-lists', () => ({
  useTaskLists: () => [workList, personalList, peopleList],
}));

const mockDeleteTasksBatch = vi.fn();
const mockSetTaskStatusBatch = vi.fn();
const mockMoveTasksToListBatch = vi.fn();
const mockRestoreTask = vi.fn();

vi.mock('../../hooks/use-bulk-operations', () => ({
  deleteTasksBatch: (...args: unknown[]) => mockDeleteTasksBatch(...args),
  setTaskStatusBatch: (...args: unknown[]) => mockSetTaskStatusBatch(...args),
  moveTasksToListBatch: (...args: unknown[]) => mockMoveTasksToListBatch(...args),
}));

vi.mock('../../hooks/use-tasks', () => ({
  restoreTask: (...args: unknown[]) => mockRestoreTask(...args),
}));

const activeTaskIds = ['t1', 't2', 't3', 't4'];

describe('BulkActionBar', () => {
  beforeEach(() => {
    resetAppState();
    vi.clearAllMocks();
    useAppState.setState({
      bulkMode: true,
      selectedTaskIds: new Set(['t1', 't2']),
    });
  });

  function renderBar() {
    const user = userEvent.setup();
    const result = render(
      <>
        <ConfirmDialogContainer />
        <ToastContainer />
        <BulkActionBar activeTaskIds={activeTaskIds} currentListId="work" />
      </>,
    );
    return { user, ...result };
  }

  it('shows the selection count', () => {
    renderBar();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('marks selected tasks as done', async () => {
    const { user } = renderBar();
    // Desktop bar has "Done" button
    const doneButtons = screen.getAllByText('Done');
    await user.click(doneButtons[0]);
    expect(mockSetTaskStatusBatch).toHaveBeenCalledWith(['t1', 't2'], 'done');
  });

  it('marks selected tasks as todo', async () => {
    const { user } = renderBar();
    const todoButtons = screen.getAllByText('Todo');
    await user.click(todoButtons[0]);
    expect(mockSetTaskStatusBatch).toHaveBeenCalledWith(['t1', 't2'], 'todo');
  });

  it('marks selected tasks as blocked', async () => {
    const { user } = renderBar();
    const blockButtons = screen.getAllByText('Block');
    await user.click(blockButtons[0]);
    expect(mockSetTaskStatusBatch).toHaveBeenCalledWith(['t1', 't2'], 'blocked');
  });

  it('deletes selected tasks with confirmation', async () => {
    const { user } = renderBar();
    const deleteButtons = screen.getAllByText('Delete');
    await user.click(deleteButtons[0]);
    // Confirm dialog should appear
    expect(screen.getByText('Delete 2 tasks?')).toBeInTheDocument();
    // Click the confirm button (inside dialog)
    const dialog = screen.getByRole('dialog');
    const dialogDeleteBtn = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === 'Delete');
    await user.click(dialogDeleteBtn!);
    expect(mockDeleteTasksBatch).toHaveBeenCalledWith(['t1', 't2']);
  });

  it('does not delete when confirmation is cancelled', async () => {
    const { user } = renderBar();
    const deleteButtons = screen.getAllByText('Delete');
    await user.click(deleteButtons[0]);
    // Click Cancel inside the dialog
    const dialog = screen.getByRole('dialog');
    const cancelBtn = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
    await user.click(cancelBtn!);
    expect(mockDeleteTasksBatch).not.toHaveBeenCalled();
  });

  it('selects all tasks when All is clicked', async () => {
    const { user } = renderBar();
    await user.click(screen.getByText('All'));
    const state = useAppState.getState();
    expect(state.selectedTaskIds).toEqual(new Set(activeTaskIds));
  });

  it('clears selection and exits bulk mode when Cancel is clicked', async () => {
    const { user } = renderBar();
    // Desktop Cancel button
    const cancelButtons = screen.getAllByText('Cancel');
    await user.click(cancelButtons[0]);
    const state = useAppState.getState();
    expect(state.bulkMode).toBe(false);
    expect(state.selectedTaskIds.size).toBe(0);
  });

  it('clears selection after status action', async () => {
    const { user } = renderBar();
    const doneButtons = screen.getAllByText('Done');
    await user.click(doneButtons[0]);
    const state = useAppState.getState();
    expect(state.bulkMode).toBe(false);
  });

  describe('Move', () => {
    async function moveTo(user: ReturnType<typeof userEvent.setup>, listName: string) {
      // Desktop and mobile bars both render (CSS shows one); use the desktop Move.
      await user.click(screen.getAllByText('Move')[0]);
      await user.click(screen.getByText(listName));
    }

    it('offers follow-up lists as targets', async () => {
      const { user } = renderBar();
      await user.click(screen.getAllByText('Move')[0]);
      expect(screen.getByText('People')).toBeInTheDocument();
    });

    it('reports a full move', async () => {
      mockMoveTasksToListBatch.mockResolvedValue({ moved: 2, skipped: 0 });
      const { user } = renderBar();
      await moveTo(user, 'People');
      expect(mockMoveTasksToListBatch).toHaveBeenCalledWith(['t1', 't2'], 'people');
      expect(await screen.findByText('2 tasks moved to People')).toBeInTheDocument();
    });

    it('says which tasks stayed behind because of their subtasks', async () => {
      mockMoveTasksToListBatch.mockResolvedValue({ moved: 1, skipped: 1 });
      const { user } = renderBar();
      await moveTo(user, 'People');
      expect(await screen.findByText("1 task moved to People — 1 with subtasks stayed (can't become a follow-up)")).toBeInTheDocument();
    });

    it('explains when nothing could move', async () => {
      mockMoveTasksToListBatch.mockResolvedValue({ moved: 0, skipped: 2 });
      const { user } = renderBar();
      await moveTo(user, 'People');
      expect(await screen.findByText("Tasks with subtasks can't become follow-ups")).toBeInTheDocument();
      expect(screen.queryByText(/moved to People/)).not.toBeInTheDocument();
    });

    it('opens only the picker of the bar that was used (regression: a hidden twin closed it)', async () => {
      const { user } = renderBar();
      await user.click(screen.getAllByText('Move')[1]); // mobile bar
      expect(screen.getAllByText('People')).toHaveLength(1);
    });

    it('claims nothing when the move failed', async () => {
      mockMoveTasksToListBatch.mockResolvedValue({ moved: 0, skipped: 0 });
      const { user } = renderBar();
      await moveTo(user, 'Personal');
      await Promise.resolve();
      expect(screen.queryByText(/moved to Personal/)).not.toBeInTheDocument();
    });
  });
});
