import { create } from 'zustand';

interface AppState {
  selectedListId: string | null;
  expandedTaskIds: Set<string>;
  focusedItemId: string | null;
  focusZone: 'sidebar' | 'main';
  editingItemId: string | null;
  bannerFocusIndex: number;
  addingSubtaskToTaskId: string | null;
  creatingTask: boolean;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  helpOpen: boolean;
  trashOpen: boolean;
  searchQuery: string;
  navigateToTaskId: string | null;
  quickCaptureOpen: boolean;
  // Bulk operations
  bulkMode: boolean;
  selectedTaskIds: Set<string>;
  // Weekly review
  weeklyReviewOpen: boolean;

  selectList: (id: string | null) => void;
  toggleTaskExpanded: (id: string) => void;
  ensureTaskExpanded: (id: string) => void;
  setFocusedItem: (id: string | null) => void;
  setFocusZone: (zone: 'sidebar' | 'main') => void;
  setEditingItemId: (id: string | null) => void;
  setBannerFocusIndex: (n: number) => void;
  setAddingSubtaskToTaskId: (id: string | null) => void;
  setCreatingTask: (v: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setTrashOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  setNavigateToTaskId: (id: string | null) => void;
  setQuickCaptureOpen: (open: boolean) => void;
  // Bulk operations
  setBulkMode: (on: boolean) => void;
  toggleTaskSelected: (id: string) => void;
  selectAllTasks: (ids: string[]) => void;
  clearSelection: () => void;
  // Weekly review
  setWeeklyReviewOpen: (open: boolean) => void;
}

export const useAppState = create<AppState>((set) => ({
  selectedListId: null,
  expandedTaskIds: new Set(),
  focusedItemId: null,
  focusZone: 'main',
  editingItemId: null,
  bannerFocusIndex: 0,
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

  selectList: (id) => set({ selectedListId: id, searchQuery: '', bulkMode: false, selectedTaskIds: new Set() }),
  toggleTaskExpanded: (id) =>
    set((state) => {
      const next = new Set(state.expandedTaskIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expandedTaskIds: next };
    }),
  ensureTaskExpanded: (id) =>
    set((state) => {
      if (state.expandedTaskIds.has(id)) return state;
      const next = new Set(state.expandedTaskIds);
      next.add(id);
      return { expandedTaskIds: next };
    }),
  setFocusedItem: (id) => set({ focusedItemId: id }),
  setFocusZone: (zone) => set({ focusZone: zone }),
  setEditingItemId: (id) => set({ editingItemId: id }),
  setBannerFocusIndex: (n) => set({ bannerFocusIndex: n }),
  setAddingSubtaskToTaskId: (id) => set({ addingSubtaskToTaskId: id }),
  setCreatingTask: (v) => set({ creatingTask: v }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setTrashOpen: (open) => set({ trashOpen: open }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setNavigateToTaskId: (id) => set({ navigateToTaskId: id }),
  setQuickCaptureOpen: (open) => set({ quickCaptureOpen: open }),
  setBulkMode: (on) => set({ bulkMode: on, selectedTaskIds: on ? new Set() : new Set() }),
  toggleTaskSelected: (id) =>
    set((state) => {
      const next = new Set(state.selectedTaskIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedTaskIds: next };
    }),
  selectAllTasks: (ids) => set({ selectedTaskIds: new Set(ids) }),
  clearSelection: () => set({ selectedTaskIds: new Set(), bulkMode: false }),
  setWeeklyReviewOpen: (open) => set({ weeklyReviewOpen: open }),
}));
