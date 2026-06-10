import { useAppState } from '../../stores/app-state';

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
    weeklyReviewOpen: false,
  });
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

    it('setWeeklyReviewOpen', () => {
      getState().setWeeklyReviewOpen(true);
      expect(getState().weeklyReviewOpen).toBe(true);
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
});
