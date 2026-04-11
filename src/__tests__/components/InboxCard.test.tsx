// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { makeTask, makeTaskList } from '../helpers/component-helpers';
import { InboxCard } from '../../components/tasks/InboxCard';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';
import { ToastContainer } from '../../components/ui/Toast';

const inboxList = makeTaskList({ id: 'inbox', name: 'Inbox', type: 'tasks' });
const workList = makeTaskList({ id: 'work', name: 'Work', type: 'tasks' });

vi.mock('../../hooks/use-task-lists', () => ({
  useTaskLists: () => [inboxList, workList],
}));

const mockDeleteTask = vi.fn();
const mockRestoreTask = vi.fn();
const mockMoveTaskToList = vi.fn();

vi.mock('../../hooks/use-tasks', () => ({
  deleteTask: (...args: unknown[]) => mockDeleteTask(...args),
  restoreTask: (...args: unknown[]) => mockRestoreTask(...args),
  moveTaskToList: (...args: unknown[]) => mockMoveTaskToList(...args),
}));

describe('InboxCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderCard(taskOverrides: Partial<Parameters<typeof makeTask>[1]> = {}) {
    const task = makeTask(inboxList.id, { title: 'Inbox item', ...taskOverrides });
    const user = userEvent.setup();
    const result = render(
      <>
        <ConfirmDialogContainer />
        <ToastContainer />
        <InboxCard task={task} index={0} />
      </>,
    );
    return { task, user, ...result };
  }

  it('displays the task title', () => {
    renderCard({ title: 'Process me' });
    expect(screen.getByText('Process me')).toBeInTheDocument();
  });

  it('shows the Process dropdown button', () => {
    renderCard();
    expect(screen.getByText('Process')).toBeInTheDocument();
  });

  it('shows target lists in Process dropdown (excluding inbox)', async () => {
    const { user } = renderCard();
    await user.click(screen.getByText('Process'));
    expect(screen.getByText('Work')).toBeInTheDocument();
    // Inbox should not appear as a target
    expect(screen.queryAllByText('Inbox').length).toBeLessThanOrEqual(0);
  });

  it('moves task to list when dropdown item is clicked', async () => {
    const { user, task } = renderCard();
    await user.click(screen.getByText('Process'));
    await user.click(screen.getByText('Work'));
    expect(mockMoveTaskToList).toHaveBeenCalledWith(task.id, 'work');
  });

  it('shows delete button', () => {
    renderCard();
    expect(screen.getByLabelText('Delete')).toBeInTheDocument();
  });

  it('deletes task after confirmation', async () => {
    const { user, task } = renderCard();
    await user.click(screen.getByLabelText('Delete'));
    // ConfirmDialog should appear
    expect(screen.getByText('Delete this task?')).toBeInTheDocument();
    // The ConfirmDialog has the confirm button with custom label "Delete"
    // There's also the card's delete button, so we find the one inside the dialog
    const dialog = screen.getByRole('dialog');
    const confirmBtn = dialog.querySelector('button');
    // Find the "Delete" button inside the dialog (it's the danger-styled one)
    const dialogButtons = dialog.querySelectorAll('button');
    const deleteBtn = Array.from(dialogButtons).find(b => b.textContent === 'Delete');
    expect(deleteBtn).toBeTruthy();
    await user.click(deleteBtn!);
    expect(mockDeleteTask).toHaveBeenCalledWith(task.id);
  });

  it('does not delete when confirmation is cancelled', async () => {
    const { user } = renderCard();
    await user.click(screen.getByLabelText('Delete'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });

  it('has a drag handle', () => {
    renderCard();
    const dragHandle = document.querySelector('[draggable="true"]');
    expect(dragHandle).toBeTruthy();
  });
});
