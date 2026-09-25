// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import '../setup-component';
import { db, ensureDefaults } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { resetAppState } from '../helpers/component-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, deleteTask } from '../../hooks/use-tasks';
import { FocusView } from '../../components/focus/FocusView';

vi.mock('../../components/banners/MotivationBanner', () => ({ MotivationBanner: () => null }));

// Focus maintenance also runs once a minute; everything below must happen well
// before that (waitFor gives up after 5 s), i.e. because the data changed.
const shownTitles = () => screen.queryAllByText(/^Task \d$/).map((el) => el.textContent);

let listId: string;

beforeEach(async () => {
  await resetDb();
  resetAppState();
  listId = (await createTaskList('Work')).id;
});

describe('FocusView', { timeout: 20_000 }, () => {
  // App seeds its settings after Focus has mounted and run its first check, so
  // a fresh install showed a blank Focus until the next minute's check.
  it('fills the set as soon as a fresh install has its settings', async () => {
    for (let i = 0; i < 4; i++) await createTask(listId, { title: `Task ${i}` });
    await db.localSettings.delete('local');

    render(<FocusView />);
    await new Promise((resolve) => setTimeout(resolve, 100)); // first check: nothing to go on
    expect(shownTitles()).toHaveLength(0);
    await ensureDefaults();

    await waitFor(() => expect(shownTitles()).toHaveLength(3));
  });

  it('tops up a slot lost to a deletion straight away', async () => {
    for (let i = 0; i < 4; i++) await createTask(listId, { title: `Task ${i}` });
    render(<FocusView />);
    await waitFor(() => expect(shownTitles()).toHaveLength(3));
    const shown = shownTitles();
    const spare = ['Task 0', 'Task 1', 'Task 2', 'Task 3'].find((t) => !shown.includes(t))!;

    const victim = assertDefined((await db.tasks.toArray()).find((t) => t.title === shown[0]));
    await deleteTask(victim.id);

    await waitFor(() => expect(shownTitles().sort()).toEqual([...shown.slice(1), spare].sort()));
  });

  it('takes in a new task while the set has room', async () => {
    await createTask(listId, { title: 'Task 0' });
    render(<FocusView />);
    await waitFor(() => expect(shownTitles()).toEqual(['Task 0']));

    await createTask(listId, { title: 'Task 1' });

    await waitFor(() => expect(shownTitles().sort()).toEqual(['Task 0', 'Task 1']));
  });

  // "New tasks arrive tomorrow" — but a slot lost to anything but finishing is
  // refilled at once; only a finished task's slot waits for tomorrow.
  it('says which slots wait for tomorrow', async () => {
    render(<FocusView />);
    expect(screen.queryByText(/New tasks arrive tomorrow/)).toBeNull();
    expect(screen.getByText(/finished task.*tomorrow/i)).toBeInTheDocument();
  });
});
