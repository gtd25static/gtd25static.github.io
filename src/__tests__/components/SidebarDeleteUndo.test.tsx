// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import '../setup-component';
import { resetAppState, resetFactories, makeTaskList, renderWithUser } from '../helpers/component-helpers';
import { DndProvider } from '../../components/layout/DndProvider';
import { Sidebar } from '../../components/layout/Sidebar';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';
import { ToastContainer } from '../../components/ui/Toast';
import { useTaskLists, deleteTaskList, restoreTaskList } from '../../hooks/use-task-lists';

vi.mock('../../components/pomodoro/PomodoroBar', () => ({ PomodoroBar: () => null }));
vi.mock('../../components/layout/SyncIndicator', () => ({ SyncIndicator: () => null }));
vi.mock('../../components/layout/CheckForUpdatesButton', () => ({ CheckForUpdatesButton: () => null }));

vi.mock('../../hooks/use-task-lists', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/use-task-lists')>();
  return {
    ...actual,
    useTaskLists: vi.fn(() => []),
    deleteTaskList: vi.fn(async () => 12_345),
    restoreTaskList: vi.fn(async () => {}),
  };
});

beforeEach(() => {
  resetAppState();
  resetFactories();
  vi.mocked(useTaskLists).mockReturnValue([makeTaskList({ id: 'errands', name: 'Errands' })]);
});

// Restoring one of its tasks from the Trash revives the list, and the Undo then
// found a live list and restored nothing else. It passes the delete's time now.
it('the "List deleted" Undo restores what that delete took', async () => {
  const { user } = renderWithUser(
    <DndProvider>
      <ConfirmDialogContainer />
      <ToastContainer />
      <Sidebar />
    </DndProvider>,
  );
  const row = (await screen.findByText('Errands')).closest('[data-focus-id]') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: 'List options' }));
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
  expect(deleteTaskList).toHaveBeenCalledWith('errands');

  await user.click(await screen.findByRole('button', { name: 'Undo' }));
  expect(restoreTaskList).toHaveBeenCalledWith('errands', 12_345);
});
