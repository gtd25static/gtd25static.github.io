import { create } from 'zustand';
import type { FollowUpSort } from '../lib/task-sort';

/** How one follow-up list is shown: its "Show snoozed", its Resolved section, its order. */
export interface FollowUpView {
  showSnoozed: boolean;
  showResolved: boolean;
  sort: FollowUpSort;
}

export const DEFAULT_FOLLOW_UP_VIEW: FollowUpView = { showSnoozed: false, showResolved: false, sort: 'manual' };

// "Stalest first" on the follow-up lists: device-local, never synced. A bare
// flag on purpose — no list ids, no content (see followUpViews below).
const STALEST_FIRST_KEY = 'gtd25-follow-up-stalest';

export function readFollowUpStalestFirst(): boolean {
  try {
    return localStorage.getItem(STALEST_FIRST_KEY) === '1';
  } catch {
    return false;
  }
}

interface AppState {
  selectedListId: string | null;
  expandedTaskIds: Set<string>;
  focusedItemId: string | null;
  focusZone: 'sidebar' | 'main';
  editingItemId: string | null;
  addingSubtaskToTaskId: string | null;
  creatingTask: boolean;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  helpOpen: boolean;
  trashOpen: boolean;
  searchQuery: string;
  // The open list's quick filter (ListFilterBar). Cleared when another list is
  // selected, and on lock.
  listFilter: string;
  navigateToTaskId: string | null;
  quickCaptureOpen: boolean;
  // Mindmaps: id of the map open in the editor (null = folder browser).
  // Survives switching sections so returning to Mindmaps restores the open map.
  openMindmapId: string | null;
  /** The folder the mindmap browser shows; kept here so it survives opening a map. */
  mindmapFolderId: string | undefined;
  // Paranoid extra: shoulder-surfing redact mode is ACTIVE (feature gate lives
  // in localSettings). Mirrored to localStorage so it survives a lock/unlock
  // cycle in public — the one moment you most need it to stick.
  redacted: boolean;
  // Bulk operations
  bulkMode: boolean;
  selectedTaskIds: Set<string>;
  // Each follow-up list's view, by list id, so leaving a list doesn't reset it.
  // Memory only, on purpose: on disk, the ids of lists that no longer exist
  // would outlive them.
  followUpViews: Record<string, FollowUpView>;
  // "Stalest first": every follow-up list in last-discussed order, over its own
  // order. Kept on this device (STALEST_FIRST_KEY).
  followUpStalestFirst: boolean;
  // Unsent text in a follow-up's "What was discussed?" box, by task id, so that
  // closing the card or leaving the list doesn't lose it. Decrypted content:
  // memory only, and forgotten on lock (lib/forget-on-lock.ts).
  noteDrafts: Record<string, string>;
  // The follow-up whose note box takes the focus once its log opens: opened from
  // the keyboard or with a mouse — not by touch, where it would pop up the
  // on-screen keyboard over the log.
  noteFocusTaskId: string | null;

  selectList: (id: string | null) => void;
  toggleTaskExpanded: (id: string) => void;
  ensureTaskExpanded: (id: string) => void;
  setFocusedItem: (id: string | null) => void;
  setFocusZone: (zone: 'sidebar' | 'main') => void;
  setEditingItemId: (id: string | null) => void;
  setAddingSubtaskToTaskId: (id: string | null) => void;
  setCreatingTask: (v: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setTrashOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  setListFilter: (query: string) => void;
  setNavigateToTaskId: (id: string | null) => void;
  setQuickCaptureOpen: (open: boolean) => void;
  setOpenMindmapId: (id: string | null) => void;
  setMindmapFolderId: (id: string | undefined) => void;
  setRedacted: (on: boolean) => void;
  // Bulk operations
  setBulkMode: (on: boolean) => void;
  toggleTaskSelected: (id: string) => void;
  selectAllTasks: (ids: string[]) => void;
  clearSelection: () => void;
  setFollowUpView: (listId: string, patch: Partial<FollowUpView>) => void;
  setFollowUpStalestFirst: (on: boolean) => void;
  setNoteDraft: (taskId: string, text: string) => void;
  clearNoteDrafts: () => void;
  setNoteFocusTaskId: (id: string | null) => void;
}

export const useAppState = create<AppState>((set) => ({
  // Focus Mode is the default view on open — the 2-3 task commitment set greets
  // you before the full lists do. AppShell's auto-select only fires on null.
  selectedListId: '__focus__',
  expandedTaskIds: new Set(),
  focusedItemId: null,
  focusZone: 'main',
  editingItemId: null,
  addingSubtaskToTaskId: null,
  creatingTask: false,
  // Only matters below md (the drawer); on phones the app opens on the Focus view,
  // not behind the drawer. Desktop always shows the sidebar.
  sidebarOpen: typeof window === 'undefined' || window.innerWidth >= 768,
  settingsOpen: false,
  helpOpen: false,
  trashOpen: false,
  redacted: typeof localStorage !== 'undefined' && localStorage.getItem('gtd25-redacted') === '1',
  searchQuery: '',
  listFilter: '',
  navigateToTaskId: null,
  quickCaptureOpen: false,
  openMindmapId: null,
  mindmapFolderId: undefined,
  bulkMode: false,
  selectedTaskIds: new Set(),
  followUpViews: {},
  followUpStalestFirst: readFollowUpStalestFirst(),
  noteDrafts: {},
  noteFocusTaskId: null,

  // The keyboard ring and any half-open form belong to the view being left: kept,
  // `d` could toggle a task of the previous list, and `n` left a new-task form
  // that opened in whichever list came next. Callers that focus something in the
  // new view (search, reveal) set it after this.
  selectList: (id) => set({
    selectedListId: id, searchQuery: '', listFilter: '', bulkMode: false, selectedTaskIds: new Set(),
    focusedItemId: null, creatingTask: false, addingSubtaskToTaskId: null, editingItemId: null,
  }),
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
  setAddingSubtaskToTaskId: (id) => set({ addingSubtaskToTaskId: id }),
  setCreatingTask: (v) => set({ creatingTask: v }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setTrashOpen: (open) => set({ trashOpen: open }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setListFilter: (query) => set({ listFilter: query }),
  setNavigateToTaskId: (id) => set({ navigateToTaskId: id }),
  setQuickCaptureOpen: (open) => set({ quickCaptureOpen: open }),
  setOpenMindmapId: (id) => set({ openMindmapId: id }),
  setMindmapFolderId: (id) => set({ mindmapFolderId: id }),
  setRedacted: (on) => {
    try {
      if (on) localStorage.setItem('gtd25-redacted', '1');
      else localStorage.removeItem('gtd25-redacted');
    } catch { /* best-effort */ }
    set({ redacted: on });
  },
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
  setFollowUpView: (listId, patch) =>
    set((state) => ({
      followUpViews: {
        ...state.followUpViews,
        [listId]: { ...(state.followUpViews[listId] ?? DEFAULT_FOLLOW_UP_VIEW), ...patch },
      },
    })),
  setFollowUpStalestFirst: (on) => {
    try {
      if (on) localStorage.setItem(STALEST_FIRST_KEY, '1');
      else localStorage.removeItem(STALEST_FIRST_KEY);
    } catch { /* best-effort: still on for this session */ }
    set({ followUpStalestFirst: on });
  },
  setNoteDraft: (taskId, text) =>
    set((state) => {
      const noteDrafts = { ...state.noteDrafts };
      if (text) noteDrafts[taskId] = text;
      else delete noteDrafts[taskId];
      return { noteDrafts };
    }),
  clearNoteDrafts: () => set({ noteDrafts: {}, noteFocusTaskId: null }),
  setNoteFocusTaskId: (id) => set({ noteFocusTaskId: id }),
}));

// Each view as "Stalest first" shows it, one object per view: a selector that
// returned a fresh object on every call would re-render its component forever.
const stalestViews = new WeakMap<FollowUpView, FollowUpView>();

/**
 * The view of follow-up list `listId` (the defaults until it's changed), in
 * last-discussed order while "Stalest first" is on — the list and j/k both read
 * it, so they walk the same order.
 */
export function selectFollowUpView(listId: string | null) {
  return (state: AppState): FollowUpView => {
    const view = (listId && state.followUpViews[listId]) || DEFAULT_FOLLOW_UP_VIEW;
    if (!state.followUpStalestFirst) return view;
    let stalest = stalestViews.get(view);
    if (!stalest) {
      stalest = { ...view, sort: 'discussed' };
      stalestViews.set(view, stalest);
    }
    return stalest;
  };
}
