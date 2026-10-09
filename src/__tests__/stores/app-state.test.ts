import { useAppState, selectFollowUpView, DEFAULT_FOLLOW_UP_VIEW, readFollowUpStalestFirst } from '../../stores/app-state';

function getState() {
  return useAppState.getState();
}

function resetStore() {
  useAppState.setState({
    selectedListId: null,
    expandedTaskIds: new Set(),
    focusedItemId: null,
    focusZone: 'main',
    editingItemId: null,
    addingSubtaskToTaskId: null,
    creatingTask: false,
    sidebarOpen: true,
    settingsOpen: false,
    helpOpen: false,
    trashOpen: false,
    searchQuery: '',
    navigateToTaskId: null,
    quickCaptureOpen: false,
    bulkMode: false,
    selectedTaskIds: new Set(),
    followUpViews: {},
    followUpStalestFirst: false,
  });
  localStorage.removeItem('gtd25-follow-up-stalest');
}

describe('app-state store', () => {
  beforeEach(resetStore);

  describe('selectList', () => {
    it('sets selectedListId', () => {
      getState().selectList('list-1');
      expect(getState().selectedListId).toBe('list-1');
    });

    it('clears searchQuery on list change', () => {
      useAppState.setState({ searchQuery: 'hello' });
      getState().selectList('list-2');
      expect(getState().searchQuery).toBe('');
    });

    it('exits bulk mode on list change', () => {
      useAppState.setState({ bulkMode: true, selectedTaskIds: new Set(['t1']) });
      getState().selectList('list-2');
      expect(getState().bulkMode).toBe(false);
      expect(getState().selectedTaskIds.size).toBe(0);
    });

    // The keyboard ring and a half-open form belonged to the view being left:
    // `d` could toggle a task of the previous list, and `n` pressed in Focus left
    // a new-task form that opened later in whichever list came next.
    it('drops the keyboard focus and any half-open form of the view it leaves', () => {
      useAppState.setState({ focusedItemId: 't1', creatingTask: true, addingSubtaskToTaskId: 't1', editingItemId: 't1' });
      getState().selectList('list-2');
      expect(getState().focusedItemId).toBeNull();
      expect(getState().creatingTask).toBe(false);
      expect(getState().addingSubtaskToTaskId).toBeNull();
      expect(getState().editingItemId).toBeNull();
    });

    it('keeps what a caller sets up before navigating (search, reveal)', () => {
      useAppState.setState({ navigateToTaskId: 't1', expandedTaskIds: new Set(['t1']) });
      getState().selectList('list-2');
      expect(getState().navigateToTaskId).toBe('t1');
      expect(getState().expandedTaskIds.has('t1')).toBe(true);
    });

    it('allows selecting null', () => {
      getState().selectList('list-1');
      getState().selectList(null);
      expect(getState().selectedListId).toBeNull();
    });
  });

  describe('toggleTaskExpanded', () => {
    it('adds task id to expanded set', () => {
      getState().toggleTaskExpanded('t1');
      expect(getState().expandedTaskIds.has('t1')).toBe(true);
    });

    it('removes task id on second toggle', () => {
      getState().toggleTaskExpanded('t1');
      getState().toggleTaskExpanded('t1');
      expect(getState().expandedTaskIds.has('t1')).toBe(false);
    });

    it('handles multiple expanded tasks', () => {
      getState().toggleTaskExpanded('t1');
      getState().toggleTaskExpanded('t2');
      expect(getState().expandedTaskIds.has('t1')).toBe(true);
      expect(getState().expandedTaskIds.has('t2')).toBe(true);
    });
  });

  describe('ensureTaskExpanded', () => {
    it('adds task if not already expanded', () => {
      getState().ensureTaskExpanded('t1');
      expect(getState().expandedTaskIds.has('t1')).toBe(true);
    });

    it('does not duplicate if already expanded', () => {
      getState().toggleTaskExpanded('t1');
      getState().ensureTaskExpanded('t1');
      expect(getState().expandedTaskIds.has('t1')).toBe(true);
    });
  });

  describe('simple setters', () => {
    it('setFocusedItem', () => {
      getState().setFocusedItem('t1');
      expect(getState().focusedItemId).toBe('t1');
      getState().setFocusedItem(null);
      expect(getState().focusedItemId).toBeNull();
    });

    it('setFocusZone', () => {
      getState().setFocusZone('sidebar');
      expect(getState().focusZone).toBe('sidebar');
      getState().setFocusZone('main');
      expect(getState().focusZone).toBe('main');
    });

    it('setEditingItemId', () => {
      getState().setEditingItemId('t1');
      expect(getState().editingItemId).toBe('t1');
    });

    it('setAddingSubtaskToTaskId', () => {
      getState().setAddingSubtaskToTaskId('t1');
      expect(getState().addingSubtaskToTaskId).toBe('t1');
    });

    it('setCreatingTask', () => {
      getState().setCreatingTask(true);
      expect(getState().creatingTask).toBe(true);
    });

    it('setSidebarOpen', () => {
      getState().setSidebarOpen(false);
      expect(getState().sidebarOpen).toBe(false);
    });

    it('setSettingsOpen', () => {
      getState().setSettingsOpen(true);
      expect(getState().settingsOpen).toBe(true);
    });

    it('setHelpOpen', () => {
      getState().setHelpOpen(true);
      expect(getState().helpOpen).toBe(true);
    });

    it('setTrashOpen', () => {
      getState().setTrashOpen(true);
      expect(getState().trashOpen).toBe(true);
    });

    it('setSearchQuery', () => {
      getState().setSearchQuery('hello');
      expect(getState().searchQuery).toBe('hello');
    });

    it('setNavigateToTaskId', () => {
      getState().setNavigateToTaskId('t1');
      expect(getState().navigateToTaskId).toBe('t1');
    });

    it('setQuickCaptureOpen', () => {
      getState().setQuickCaptureOpen(true);
      expect(getState().quickCaptureOpen).toBe(true);
    });
  });

  describe('bulk operations', () => {
    it('setBulkMode clears selection when entering bulk mode', () => {
      useAppState.setState({ selectedTaskIds: new Set(['t1']) });
      getState().setBulkMode(true);
      expect(getState().bulkMode).toBe(true);
      expect(getState().selectedTaskIds.size).toBe(0);
    });

    it('setBulkMode clears selection when exiting bulk mode', () => {
      useAppState.setState({ bulkMode: true, selectedTaskIds: new Set(['t1']) });
      getState().setBulkMode(false);
      expect(getState().bulkMode).toBe(false);
      expect(getState().selectedTaskIds.size).toBe(0);
    });

    it('toggleTaskSelected adds and removes tasks', () => {
      getState().toggleTaskSelected('t1');
      expect(getState().selectedTaskIds.has('t1')).toBe(true);
      getState().toggleTaskSelected('t1');
      expect(getState().selectedTaskIds.has('t1')).toBe(false);
    });

    it('selectAllTasks replaces current selection', () => {
      getState().toggleTaskSelected('t1');
      getState().selectAllTasks(['t2', 't3', 't4']);
      expect(getState().selectedTaskIds).toEqual(new Set(['t2', 't3', 't4']));
    });

    it('clearSelection resets both bulkMode and selectedTaskIds', () => {
      useAppState.setState({ bulkMode: true, selectedTaskIds: new Set(['t1', 't2']) });
      getState().clearSelection();
      expect(getState().bulkMode).toBe(false);
      expect(getState().selectedTaskIds.size).toBe(0);
    });
  });

  describe('follow-up list views', () => {
    it('start from the defaults and merge each change into the list\'s own view', () => {
      expect(selectFollowUpView('F1')(getState())).toBe(DEFAULT_FOLLOW_UP_VIEW);
      getState().setFollowUpView('F1', { showSnoozed: true });
      getState().setFollowUpView('F1', { sort: 'date' });
      expect(getState().followUpViews.F1).toEqual({ showSnoozed: true, showResolved: false, sort: 'date' });
      expect(selectFollowUpView('F2')(getState())).toBe(DEFAULT_FOLLOW_UP_VIEW);
    });

    it('outlive a change of list', () => {
      getState().setFollowUpView('F1', { showResolved: true });
      getState().selectList('L2');
      getState().selectList('F1');
      expect(getState().followUpViews.F1.showResolved).toBe(true);
    });

    it('are never written to localStorage', () => {
      const before = { ...localStorage };
      getState().setFollowUpView('F1', { showSnoozed: true, sort: 'discussed' });
      expect({ ...localStorage }).toEqual(before);
    });

    it('"Stalest first" orders every follow-up list by last discussed, over each list\'s own order', () => {
      getState().setFollowUpView('F1', { sort: 'date' });
      getState().setFollowUpStalestFirst(true);
      expect(selectFollowUpView('F1')(getState()).sort).toBe('discussed');
      expect(selectFollowUpView('F2')(getState()).sort).toBe('discussed');
      expect(selectFollowUpView('F1')(getState()).showSnoozed).toBe(false);
      // The same object on every call: a fresh one re-renders its subscriber forever.
      expect(selectFollowUpView('F1')(getState())).toBe(selectFollowUpView('F1')(getState()));
      expect(selectFollowUpView('F2')(getState())).toBe(selectFollowUpView('F2')(getState()));
      getState().setFollowUpStalestFirst(false);
      expect(selectFollowUpView('F1')(getState()).sort).toBe('date');
      expect(selectFollowUpView('F2')(getState())).toBe(DEFAULT_FOLLOW_UP_VIEW);
    });

    it('"Stalest first" is remembered on this device as a bare flag (no list ids)', () => {
      getState().setFollowUpStalestFirst(true);
      expect(localStorage.getItem('gtd25-follow-up-stalest')).toBe('1');
      expect(readFollowUpStalestFirst()).toBe(true);
      getState().setFollowUpStalestFirst(false);
      expect(localStorage.getItem('gtd25-follow-up-stalest')).toBeNull();
      expect(readFollowUpStalestFirst()).toBe(false);
    });

    it('"Stalest first" still works for the session when storage refuses it', () => {
      const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
      const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
      try {
        getState().setFollowUpStalestFirst(true);
        expect(getState().followUpStalestFirst).toBe(true);
        expect(readFollowUpStalestFirst()).toBe(false);
      } finally {
        setItem.mockRestore();
        getItem.mockRestore();
      }
    });
  });
});
