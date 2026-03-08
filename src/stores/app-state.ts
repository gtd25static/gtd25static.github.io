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

  selectList: (id) => set({ selectedListId: id, searchQuery: '' }),
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
}));
