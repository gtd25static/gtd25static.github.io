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

  it('signals archived follow-up reveal and scrolls the follow-up card', () => {
    renderResults([
      makeResult({ id: 'follow-1', title: 'Archived follow-up', listId: 'fu-1', listType: 'follow-ups', archived: true }),
    ], ['follow-1']);

    fireEvent.click(screen.getByText('Archived follow-up'));
    act(() => vi.runOnlyPendingTimers());

    const state = useAppState.getState();
    expect(state.selectedListId).toBe('fu-1');
    expect(state.navigateToTaskId).toBe('follow-1');
    expect(state.expandedTaskIds.has('follow-1')).toBe(false);
    expect(state.focusZone).toBe('main');
    expect(state.focusedItemId).toBe('follow-1');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });
});
