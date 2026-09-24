// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
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
import { useAppState } from '../../stores/app-state';
import type { TaskList } from '../../db/models';

vi.mock('../../components/pomodoro/PomodoroBar', () => ({ PomodoroBar: () => null }));
vi.mock('../../components/layout/SyncIndicator', () => ({ SyncIndicator: () => null }));

vi.mock('../../hooks/use-task-lists', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/use-task-lists')>();
  return { ...actual, useTaskLists: vi.fn(() => [] as TaskList[]) };
});

const lists = [
  makeTaskList({ id: 'l1', name: 'Alpha' }),
  makeTaskList({ id: 'l2', name: 'Beta' }),
  makeTaskList({ id: 'f1', name: 'People', type: 'follow-ups' }),
];

function renderSidebar() {
  return renderWithUser(<DndProvider><Sidebar /></DndProvider>);
}

beforeEach(() => {
  resetAppState();
  resetFactories();
  vi.mocked(useTaskLists).mockReturnValue(lists);
});

describe('Sidebar compact layout', () => {
  it('opens the new-list form from the + next to search (no separate Create button)', async () => {
    const { user } = renderSidebar();
    expect(screen.queryByText('Create')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('List name')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create new list' }));
    expect(screen.getByPlaceholderText('List name')).toBeInTheDocument();
  });

  it('keeps the fixed views reachable and selectable', async () => {
    const { user } = renderSidebar();
    for (const [label, id] of [['Focus', '__focus__'], ['Shared', '__shared__'], ['Mindmaps', '__mindmaps__'], ['Insights', '__insights__']]) {
      await user.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));
      expect(useAppState.getState().selectedListId).toBe(id);
    }
  });

  it('exposes the icon-only bottom actions by accessible name', async () => {
    const { user } = renderSidebar();
    expect(screen.getByRole('button', { name: 'Check for app updates' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Trash' }));
    expect(useAppState.getState().trashOpen).toBe(true);
  });

  it('labels each list section with its size in a sticky header', () => {
    renderSidebar();
    const listsHeader = screen.getByText('Lists').parentElement as HTMLElement;
    expect(listsHeader.className).toContain('sticky');
    expect(within(listsHeader).getByText('2')).toBeInTheDocument();
    const followHeader = screen.getByText('Follow-ups').parentElement as HTMLElement;
    expect(within(followHeader).getByText('1')).toBeInTheDocument();
  });

  it('scrolls the selected list into view', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    useAppState.getState().selectList('l2');
    renderSidebar();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    const target = scrollIntoView.mock.contexts[0] as HTMLElement;
    expect(target.getAttribute('data-focus-id')).toBe('l2');
  });
});
