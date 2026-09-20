// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import '../setup-component';
import {
  resetAppState,
  resetFactories,
  makeTaskList,
  renderWithUser,
} from '../helpers/component-helpers';
import { DndProvider } from '../../components/layout/DndProvider';
import { Sidebar } from '../../components/layout/Sidebar';
import { useTaskLists, archiveTaskList, unarchiveTaskList } from '../../hooks/use-task-lists';
import type { TaskList } from '../../db/models';

// Chrome that has nothing to do with lists (timer, sync badge, updates).
vi.mock('../../components/pomodoro/PomodoroBar', () => ({ PomodoroBar: () => null }));
vi.mock('../../components/layout/SyncIndicator', () => ({ SyncIndicator: () => null }));
vi.mock('../../components/layout/CheckForUpdatesButton', () => ({ CheckForUpdatesButton: () => null }));

vi.mock('../../hooks/use-task-lists', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/use-task-lists')>();
  return {
    ...actual,
    useTaskLists: vi.fn(() => [] as TaskList[]),
    archiveTaskList: vi.fn(),
    unarchiveTaskList: vi.fn(),
  };
});

const active = makeTaskList({ id: 'active-1', name: 'Active project' });
const archivedTasks = makeTaskList({ id: 'arch-1', name: 'Old project', archivedAt: 1_000 });
const archivedFollowUps = makeTaskList({ id: 'arch-2', name: 'Old contacts', type: 'follow-ups', archivedAt: 2_000 });

function setLists(lists: TaskList[]) {
  vi.mocked(useTaskLists).mockReturnValue(lists);
}

function renderSidebar() {
  return renderWithUser(<DndProvider><Sidebar /></DndProvider>);
}

/** Open the "..." menu of the sidebar row holding `nameEl`. */
async function openRowMenu(user: ReturnType<typeof renderWithUser>['user'], nameEl: HTMLElement) {
  const row = nameEl.closest('[data-focus-id]') as HTMLElement;
  const buttons = within(row).getAllByRole('button');
  await user.click(buttons[buttons.length - 1]);
}

beforeEach(() => {
  resetAppState();
  resetFactories();
  localStorage.clear();
  setLists([active, archivedTasks, archivedFollowUps]);
});

describe('Sidebar archived section', () => {
  it('keeps archived lists out of the normal sections and behind a collapsed header', async () => {
    renderSidebar();

    expect(await screen.findByText('Active project')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    // Both types are counted together in the one section.
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('Old project')).not.toBeInTheDocument();
    expect(screen.queryByText('Old contacts')).not.toBeInTheDocument();
  });

  it('expands on click, newest archive first, and remembers the choice', async () => {
    const { user, unmount } = renderSidebar();

    await user.click(screen.getByText('Archived'));

    const names = screen.getAllByText(/^Old (project|contacts)$/).map((el) => el.textContent);
    expect(names).toEqual(['Old contacts', 'Old project']);
    expect(screen.getByText(/Deleted automatically 12 months after archiving/)).toBeInTheDocument();

    unmount();
    renderSidebar();
    expect(await screen.findByText('Old project')).toBeInTheDocument();
  });

  it('is hidden entirely when nothing is archived', async () => {
    setLists([active]);
    renderSidebar();

    expect(await screen.findByText('Active project')).toBeInTheDocument();
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
  });

  it('archives an active list from its row menu', async () => {
    const { user } = renderSidebar();

    await openRowMenu(user, await screen.findByText('Active project'));
    await user.click(screen.getByText('Archive'));

    expect(archiveTaskList).toHaveBeenCalledWith('active-1');
  });

  it('offers Unarchive instead of Archive on an archived list', async () => {
    const { user } = renderSidebar();
    await user.click(screen.getByText('Archived'));

    await openRowMenu(user, await screen.findByText('Old project'));
    expect(screen.queryByText('Archive')).not.toBeInTheDocument();
    await user.click(screen.getByText('Unarchive'));

    expect(unarchiveTaskList).toHaveBeenCalledWith('arch-1');
  });

  it('opens the collapsed section when a search matches an archived list', async () => {
    const { user } = renderSidebar();

    await user.type(screen.getByPlaceholderText('Search...'), 'Old pro');

    await waitFor(() => expect(screen.getByText('Old pro')).toBeInTheDocument()); // highlighted match
    expect(screen.queryByText('Old contacts')).not.toBeInTheDocument();
  });
});
