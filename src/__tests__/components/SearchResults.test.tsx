// @vitest-environment jsdom
import { fireEvent, render, screen, act } from '@testing-library/react';
import '../setup-component';
import { resetAppState } from '../helpers/component-helpers';
import { SearchResults } from '../../components/tasks/SearchResults';
import { useAppState } from '../../stores/app-state';
import { useSearch, type SearchResult } from '../../hooks/use-search';

vi.mock('../../hooks/use-search', () => ({
  useSearch: vi.fn(),
}));

const scrollIntoView = vi.fn();

function makeResult(overrides: Partial<SearchResult>): SearchResult {
  return {
    type: 'task',
    id: 'task-1',
    title: 'Result',
    status: 'todo',
    listId: 'list-1',
    listName: 'List',
    listType: 'tasks',
    ...overrides,
  };
}

function renderResults(results: SearchResult[], targets: string[]) {
  vi.mocked(useSearch).mockReturnValue({ results, isSearching: false, maxReached: false });
  useAppState.setState({ searchQuery: 'result' });
  return render(
    <>
      {targets.map((id) => (
        <div key={id} data-focus-id={id} />
      ))}
      <SearchResults />
    </>,
  );
}

describe('SearchResults navigation', () => {
  beforeEach(() => {
    resetAppState();
    vi.clearAllMocks();
    vi.useFakeTimers();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('selects lists and scrolls the sidebar target', () => {
    renderResults([
      makeResult({ type: 'list', id: 'list-1', title: 'People', status: 'list', listId: 'list-1', listName: 'People', listType: 'follow-ups' }),
    ], ['list-1']);

    fireEvent.click(screen.getByText('People'));
    act(() => vi.runOnlyPendingTimers());

    const state = useAppState.getState();
    expect(state.selectedListId).toBe('list-1');
    expect(state.searchQuery).toBe('');
    expect(state.focusZone).toBe('sidebar');
    expect(state.focusedItemId).toBe('list-1');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('expands parent tasks and scrolls subtask results into view', () => {
    renderResults([
      makeResult({
        type: 'subtask',
        id: 'sub-1',
        title: 'Nested result',
        parentTaskId: 'task-1',
        parentTaskTitle: 'Parent',
      }),
    ], ['sub-1']);

    fireEvent.click(screen.getByRole('button', { name: /Nested result/ }));
    act(() => vi.runOnlyPendingTimers());

    const state = useAppState.getState();
    expect(state.selectedListId).toBe('list-1');
    expect(state.navigateToTaskId).toBe('task-1');
    expect(state.expandedTaskIds.has('task-1')).toBe(true);
    expect(state.focusZone).toBe('main');
    expect(state.focusedItemId).toBe('sub-1');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('opens the Resolved section for a resolved follow-up, opens its log and scrolls to it', () => {
    renderResults([
      makeResult({ id: 'follow-1', title: 'Archived follow-up', listId: 'fu-1', listType: 'follow-ups', archived: true }),
    ], ['follow-1']);

    fireEvent.click(screen.getByText('Archived follow-up'));
    act(() => vi.runOnlyPendingTimers());

    const state = useAppState.getState();
    expect(state.selectedListId).toBe('fu-1');
    expect(state.followUpViews['fu-1']).toMatchObject({ showResolved: true, showSnoozed: false });
    expect(state.expandedTaskIds.has('follow-1')).toBe(true);
    expect(state.focusZone).toBe('main');
    expect(state.focusedItemId).toBe('follow-1');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  // It landed on a list that hid it: only the Resolved section was ever opened.
  it('shows the snoozed for a snoozed follow-up, so it is on screen', () => {
    renderResults([
      makeResult({ id: 'follow-2', title: 'Snoozed follow-up', listId: 'fu-1', listType: 'follow-ups', snoozed: true }),
    ], ['follow-2']);

    fireEvent.click(screen.getByText('Snoozed follow-up'));
    act(() => vi.runOnlyPendingTimers());

    const state = useAppState.getState();
    expect(state.followUpViews['fu-1']).toMatchObject({ showSnoozed: true, showResolved: false });
    expect(state.expandedTaskIds.has('follow-2')).toBe(true);
    expect(state.focusedItemId).toBe('follow-2');
  });

  it('labels follow-ups as snoozed or resolved (never "todo"), and shows why a result matched', () => {
    renderResults([
      makeResult({ id: 'f1', title: 'Awake topic', listType: 'follow-ups', match: { text: 'what we said', at: new Date(2026, 9, 1).getTime() } }),
      makeResult({ id: 'f2', title: 'Snoozed topic', listType: 'follow-ups', snoozed: true }),
      makeResult({ id: 'f3', title: 'Resolved topic', listType: 'follow-ups', archived: true }),
    ], []);
    const row = (title: string) => screen.getByText(title).closest('button')!;
    expect(row('Awake topic').textContent).not.toMatch(/todo|snoozed|resolved/);
    expect(row('Snoozed topic').textContent).toContain('snoozed');
    expect(row('Resolved topic').textContent).toContain('resolved');
    expect(row('Awake topic').textContent).toContain('01/10');
    expect(row('Awake topic').textContent).toContain('what we said');
  });
});
