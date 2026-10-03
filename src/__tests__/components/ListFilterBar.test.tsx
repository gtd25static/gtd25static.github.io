// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import '../setup-component';
import { resetAppState, renderWithDnd } from '../helpers/component-helpers';
import { resetDb } from '../helpers/db-helpers';
import { db } from '../../db';
import { useAppState } from '../../stores/app-state';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask } from '../../hooks/use-tasks';
import { TaskListView } from '../../components/tasks/TaskListView';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';
import { useKeyboard } from '../../hooks/use-keyboard';
import type { Task } from '../../db/models';

// A list-level test: the cards render just their title.
vi.mock('../../components/tasks/TaskCard', () => ({
  TaskCard: ({ task }: { task: Task }) => <div data-testid="card">{task.title}</div>,
}));
vi.mock('../../components/follow-ups/FollowUpCard', () => ({
  FollowUpCard: ({ task }: { task: Task }) => <div data-testid="card">{task.title}</div>,
}));
vi.mock('../../components/tasks/InboxCard', () => ({
  InboxCard: ({ task }: { task: Task }) => <div data-testid="card">{task.title}</div>,
}));
vi.mock('../../components/tasks/MergeSuggestionsCard', () => ({ MergeSuggestionsCard: () => null }));

const TITLES = ['Revisar presupuesto', 'Llamar a Ana', 'Comprar pan', 'Preparar agenda nueva'];

async function seedList(type: 'tasks' | 'follow-ups' = 'tasks', name = 'Work') {
  const list = await createTaskList(name, type);
  for (const title of TITLES) await createTask(list.id, { title });
  act(() => useAppState.getState().selectList(list.id));
  return list;
}

/** Render, and wait for the list (read from the db) to be on screen. */
async function renderView() {
  const rendered = renderWithDnd(<><TaskListView /><ConfirmDialogContainer /></>);
  await screen.findByRole('textbox', { name: 'Filter this list' });
  return rendered;
}

async function shownTitles() {
  return (await screen.findAllByTestId('card').catch(() => [])).map((c) => c.textContent);
}

const filterInput = () => screen.getByRole('textbox', { name: 'Filter this list' });

beforeAll(() => {
  // jsdom has no layout; the keyboard hook scrolls the focused item into view.
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(async () => {
  await resetDb();
  resetAppState();
});

describe('the list quick filter', () => {
  it('narrows the list as you type, typo-tolerant but not lax', async () => {
    await seedList();
    const { user } = await renderView();
    expect(await shownTitles()).toHaveLength(4);

    await user.type(filterInput(), 'presupesto');
    await waitFor(async () => expect(await shownTitles()).toEqual(['Revisar presupuesto']));

    // "pan" is only the word, not p…a…n scattered over "Preparar agenda nueva".
    await user.clear(filterInput());
    await user.type(filterInput(), 'pan');
    await waitFor(async () => expect(await shownTitles()).toEqual(['Comprar pan']));
  });

  it('says so when nothing matches', async () => {
    await seedList();
    const { user } = await renderView();
    await user.type(filterInput(), 'zzzz');
    expect(await screen.findByText('No tasks match this filter')).toBeInTheDocument();
  });

  it('Escape clears the filter', async () => {
    await seedList();
    const { user } = await renderView();
    await user.type(filterInput(), 'ana');
    await waitFor(async () => expect(await shownTitles()).toEqual(['Llamar a Ana']));
    await user.keyboard('{Escape}');
    expect(useAppState.getState().listFilter).toBe('');
    await waitFor(async () => expect(await shownTitles()).toHaveLength(4));
  });

  it('is forgotten when another list is selected', async () => {
    await seedList();
    const other = await createTaskList('Home');
    const { user } = await renderView();
    await user.type(filterInput(), 'ana');
    act(() => useAppState.getState().selectList(other.id));
    expect(useAppState.getState().listFilter).toBe('');
  });
});

describe('saved searches as chips', () => {
  it('saves the search as a chip, and the chip brings the filter back', async () => {
    const list = await seedList();
    const { user } = await renderView();

    await user.type(filterInput(), 'ana');
    await user.click(screen.getByRole('button', { name: 'Save search' }));
    const chip = await screen.findByRole('button', { name: 'ana' });
    expect((await db.taskLists.get(list.id))?.savedSearches).toEqual(['ana']);
    // Already saved: no second Save button for it.
    expect(screen.queryByRole('button', { name: 'Save search' })).not.toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    await waitFor(async () => expect(await shownTitles()).toHaveLength(4));
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    await user.click(chip);
    expect(filterInput()).toHaveValue('ana');
    await waitFor(async () => expect(await shownTitles()).toEqual(['Llamar a Ana']));

    // Tapping the active chip again clears the filter.
    await user.click(chip);
    expect(filterInput()).toHaveValue('');
  });

  it('the X deletes a chip only after confirming', async () => {
    const list = await seedList();
    await db.taskLists.update(list.id, { savedSearches: ['ana', 'pan'] });
    const { user } = await renderView();
    await screen.findByRole('button', { name: 'ana' });

    await user.click(screen.getByRole('button', { name: 'Delete saved search “ana”' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete the saved search “ana”?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect((await db.taskLists.get(list.id))?.savedSearches).toEqual(['ana', 'pan']);

    await user.click(screen.getByRole('button', { name: 'Delete saved search “ana”' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(async () => expect((await db.taskLists.get(list.id))?.savedSearches).toEqual(['pan']));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ana' })).not.toBeInTheDocument());
  });

  it('a malformed stored value shows only the valid chips', async () => {
    const list = await seedList();
    await db.taskLists.update(list.id, { savedSearches: ['ana', 42, 'ANA', ''] as unknown as string[] });
    await renderView();
    expect(await screen.findByRole('button', { name: 'ana' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ANA' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '42' })).not.toBeInTheDocument();
  });

  it('chips and the filter text are hidden by redact mode', async () => {
    const list = await seedList();
    await db.taskLists.update(list.id, { savedSearches: ['ana'] });
    await renderView();
    const chip = await screen.findByRole('button', { name: 'ana' });
    expect(chip.querySelector('[data-redact]')).not.toBeNull();
    expect(filterInput()).toHaveAttribute('data-redact');
  });
});

describe('the other list kinds have the filter too', () => {
  it('follow-up lists', async () => {
    await seedList('follow-ups', 'People');
    const { user } = await renderView();
    await user.type(filterInput(), 'ana');
    await waitFor(async () => expect(await shownTitles()).toEqual(['Llamar a Ana']));
  });

  it('the Inbox', async () => {
    await seedList('tasks', 'Inbox');
    const { user } = await renderView();
    await user.type(filterInput(), 'ana');
    await waitFor(async () => expect(await shownTitles()).toEqual(['Llamar a Ana']));
  });
});

describe('keyboard navigation follows the filter', () => {
  function KeyboardHarness() {
    useKeyboard();
    return null;
  }

  it('j moves only through the items the filter leaves', async () => {
    const list = await seedList();
    const ana = (await db.tasks.where('listId').equals(list.id).toArray()).find((t) => t.title === 'Llamar a Ana')!;
    renderWithDnd(<><TaskListView /><KeyboardHarness /></>);
    await screen.findByRole('textbox', { name: 'Filter this list' });
    act(() => useAppState.setState({ listFilter: 'ana', focusZone: 'main', focusedItemId: 'create-task' }));
    // Both the cards and the keyboard's item list are live queries on the same change.
    await waitFor(async () => expect(await shownTitles()).toEqual(['Llamar a Ana']));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const pressJ = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })); });
    pressJ();
    expect(useAppState.getState().focusedItemId).toBe(ana.id);
    // And there is nothing after it.
    pressJ();
    expect(useAppState.getState().focusedItemId).toBe(ana.id);
  });
});
