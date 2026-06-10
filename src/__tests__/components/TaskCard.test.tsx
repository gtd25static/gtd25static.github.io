// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { resetAppState, makeTask, makeTaskList, TestDndWrapper } from '../helpers/component-helpers';
import { TaskCard } from '../../components/tasks/TaskCard';
import { useAppState } from '../../stores/app-state';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';
import { ToastContainer } from '../../components/ui/Toast';

// Mock DB-dependent hooks
const mockSubtasks: ReturnType<typeof import('../../hooks/use-subtasks').useSubtasks> = [];
const mockLists = [makeTaskList({ id: 'list-1', name: 'Work' }), makeTaskList({ id: 'list-2', name: 'Personal' })];

vi.mock('../../hooks/use-subtasks', () => ({
  useSubtasks: () => mockSubtasks,
}));

vi.mock('../../hooks/use-task-lists', () => ({
  useTaskLists: () => mockLists,
}));

// Mock DB mutation functions
const mockSetTaskStatus = vi.fn();
const mockDeleteTask = vi.fn();
const mockRestoreTask = vi.fn();
const mockUpdateTask = vi.fn();
const mockMoveTaskToList = vi.fn();
const mockDuplicateTask = vi.fn().mockResolvedValue({ id: 'dup-1' });

vi.mock('../../hooks/use-tasks', () => ({
  setTaskStatus: (...args: unknown[]) => mockSetTaskStatus(...args),
  deleteTask: (...args: unknown[]) => mockDeleteTask(...args),
  restoreTask: (...args: unknown[]) => mockRestoreTask(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  moveTaskToList: (...args: unknown[]) => mockMoveTaskToList(...args),
  duplicateTask: (...args: unknown[]) => mockDuplicateTask(...args),
}));

vi.mock('../../hooks/use-warning', () => ({
  toggleWarning: vi.fn(),
}));

const list = mockLists[0];

function renderCard(taskOverrides: Partial<Parameters<typeof makeTask>[1]> = {}) {
  const task = makeTask(list.id, taskOverrides);
  const user = userEvent.setup();
  const result = render(
    <TestDndWrapper>
      <ConfirmDialogContainer />
      <ToastContainer />
      <TaskCard task={task} index={0} />
    </TestDndWrapper>,
  );
  return { task, user, ...result };
}

describe('TaskCard', () => {
  beforeEach(() => {
    resetAppState();
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('displays the task title', () => {
      renderCard({ title: 'Buy groceries' });
      expect(screen.getByText('Buy groceries')).toBeInTheDocument();
    });

    it('shows "Mark complete" button for todo task', () => {
      renderCard({ status: 'todo' });
      expect(screen.getByLabelText('Mark complete')).toBeInTheDocument();
    });

    it('shows "Mark incomplete" button for done task', () => {
      renderCard({ status: 'done' });
      expect(screen.getByLabelText('Mark incomplete')).toBeInTheDocument();
    });

    it('applies line-through style for done tasks', () => {
      renderCard({ title: 'Done task', status: 'done' });
      const title = screen.getByText('Done task');
      expect(title).toHaveClass('line-through');
    });

    it('shows star button', () => {
      renderCard();
      expect(screen.getByTitle('Star')).toBeInTheDocument();
    });

    it('shows warning badge when hasWarning is true', () => {
      renderCard({ hasWarning: true });
      // Warning icon SVG has fill="#f59e0b"
      const svg = document.querySelector('svg[fill="#f59e0b"]');
      expect(svg).toBeTruthy();
    });
  });

  describe('checkbox interaction', () => {
    it('marks task as done when checkbox is clicked', async () => {
      const { user } = renderCard({ status: 'todo' });
      await user.click(screen.getByLabelText('Mark complete'));
      expect(mockSetTaskStatus).toHaveBeenCalledWith(expect.any(String), 'done');
    });

    it('marks task as todo when done task checkbox is clicked', async () => {
      const { user } = renderCard({ status: 'done' });
      await user.click(screen.getByLabelText('Mark incomplete'));
      expect(mockSetTaskStatus).toHaveBeenCalledWith(expect.any(String), 'todo');
    });
  });

  describe('expand/collapse', () => {
    it('expands the card on click', async () => {
      const { user, task } = renderCard({ description: 'Some description' });
      // Click the card row to expand
      await user.click(screen.getByText(task.title));
      // Should toggle expanded in app state
      expect(useAppState.getState().expandedTaskIds.has(task.id)).toBe(true);
    });

    it('shows description when expanded', async () => {
      const task = makeTask(list.id, { description: 'Detailed info here' });
      useAppState.setState({ expandedTaskIds: new Set([task.id]) });
      render(
        <TestDndWrapper>
          <TaskCard task={task} index={0} />
        </TestDndWrapper>,
      );
      expect(screen.getByText('Detailed info here')).toBeInTheDocument();
    });

    it('shows Collapse button when expanded', async () => {
      const task = makeTask(list.id, { title: 'Expandable' });
      useAppState.setState({ expandedTaskIds: new Set([task.id]) });
      render(
        <TestDndWrapper>
          <TaskCard task={task} index={0} />
        </TestDndWrapper>,
      );
      expect(screen.getByText('Collapse')).toBeInTheDocument();
    });
  });

  describe('star', () => {
    it('toggles star on click', async () => {
      const { user, task } = renderCard({ starred: false });
      await user.click(screen.getByTitle('Star'));
      expect(mockUpdateTask).toHaveBeenCalledWith(task.id, { starred: true });
    });

    it('shows unstar when already starred', () => {
      renderCard({ starred: true });
      expect(screen.getByTitle('Unstar')).toBeInTheDocument();
    });
  });

  describe('inline title editing', () => {
    it('enters edit mode on double-click', async () => {
      const { user } = renderCard({ title: 'Original title' });
      await user.dblClick(screen.getByText('Original title'));
      const input = screen.getByDisplayValue('Original title');
      expect(input).toBeInTheDocument();
      expect(input.tagName).toBe('INPUT');
    });

    it('saves edited title on Enter', async () => {
      const { user, task } = renderCard({ title: 'Old title' });
      await user.dblClick(screen.getByText('Old title'));
      const input = screen.getByDisplayValue('Old title');
      await user.clear(input);
      await user.type(input, 'New title{Enter}');
      expect(mockUpdateTask).toHaveBeenCalledWith(task.id, { title: 'New title' });
    });

    it('cancels editing on Escape', async () => {
      const { user } = renderCard({ title: 'Keep this' });
      await user.dblClick(screen.getByText('Keep this'));
      await user.keyboard('{Escape}');
      // Should go back to showing the title as text
      expect(screen.getByText('Keep this')).toBeInTheDocument();
      expect(mockUpdateTask).not.toHaveBeenCalled();
    });

    it('saves on blur', async () => {
      const { user, task } = renderCard({ title: 'Blur test' });
      await user.dblClick(screen.getByText('Blur test'));
      const input = screen.getByDisplayValue('Blur test');
      await user.clear(input);
      await user.type(input, 'Changed');
      await user.tab(); // trigger blur
      expect(mockUpdateTask).toHaveBeenCalledWith(task.id, { title: 'Changed' });
    });
  });

  describe('bulk mode', () => {
    it('shows selection checkbox in bulk mode', () => {
      useAppState.setState({ bulkMode: true, selectedTaskIds: new Set() });
      renderCard();
      expect(screen.getByLabelText('Select')).toBeInTheDocument();
    });

    it('toggles selection when checkbox is clicked in bulk mode', async () => {
      const task = makeTask(list.id, { title: 'Bulk task' });
      useAppState.setState({ bulkMode: true, selectedTaskIds: new Set() });
      const user = userEvent.setup();
      render(
        <TestDndWrapper>
          <TaskCard task={task} index={0} />
        </TestDndWrapper>,
      );
      await user.click(screen.getByLabelText('Select'));
      expect(useAppState.getState().selectedTaskIds.has(task.id)).toBe(true);
    });

    it('shows Deselect label when task is selected', () => {
      const task = makeTask(list.id, { title: 'Selected task' });
      useAppState.setState({ bulkMode: true, selectedTaskIds: new Set([task.id]) });
      render(
        <TestDndWrapper>
          <TaskCard task={task} index={0} />
        </TestDndWrapper>,
      );
      expect(screen.getByLabelText('Deselect')).toBeInTheDocument();
    });
  });

  describe('keyboard-triggered editing', () => {
    it('enters edit mode when editingItemId matches task id', () => {
      const task = makeTask(list.id, { title: 'Keyboard edit' });
      useAppState.setState({ editingItemId: task.id });
      render(
        <TestDndWrapper>
          <TaskCard task={task} index={0} />
        </TestDndWrapper>,
      );
      expect(screen.getByDisplayValue('Keyboard edit')).toBeInTheDocument();
    });
  });
});
