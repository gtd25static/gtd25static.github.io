// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import '../setup-component';
import {
  resetAppState,
  resetFactories,
  makeTaskList,
  renderWithUser,
} from '../helpers/component-helpers';
import { DndProvider } from '../../components/layout/DndProvider';
import { Sidebar } from '../../components/layout/Sidebar';
import { useTaskLists } from '../../hooks/use-task-lists';
import type { TaskList } from '../../db/models';

vi.mock('../../components/pomodoro/PomodoroBar', () => ({ PomodoroBar: () => null }));
vi.mock('../../components/layout/SyncIndicator', () => ({ SyncIndicator: () => null }));
vi.mock('../../components/layout/CheckForUpdatesButton', () => ({ CheckForUpdatesButton: () => null }));

vi.mock('../../hooks/use-task-lists', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/use-task-lists')>();
  return { ...actual, useTaskLists: vi.fn(() => [] as TaskList[]) };
});

beforeEach(() => {
  resetAppState();
  resetFactories();
  vi.mocked(useTaskLists).mockReturnValue([
    makeTaskList({ id: 'list-alpha-id', name: 'Alpha' }),
    makeTaskList({ id: 'list-beta-id', name: 'Beta' }),
  ]);
});

describe('Sidebar list drag', () => {
  it('shows the list name in the drag overlay, not its id', async () => {
    renderWithUser(<DndProvider><Sidebar /></DndProvider>);
    const row = (await screen.findByText('Alpha')).closest('[data-focus-id]') as HTMLElement;
    const sortable = row.parentElement as HTMLElement; // the useSortable wrapper
    sortable.focus();
    // KeyboardSensor: Space picks the item up.
    await act(async () => { fireEvent.keyDown(sortable, { key: ' ', code: 'Space' }); });

    expect(screen.queryByText('list-alpha-id')).not.toBeInTheDocument();
    expect(screen.getAllByText('Alpha')).toHaveLength(2); // the row + the overlay

    await act(async () => { fireEvent.keyDown(document.activeElement ?? sortable, { key: 'Escape', code: 'Escape' }); });
  });
});
