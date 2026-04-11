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

vi.mock('../../hooks/use-task-lists', () => ({
  useTaskLists: () => [workList, personalList],
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
});
