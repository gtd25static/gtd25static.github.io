import { create } from 'zustand';
import type { NodeStylePatch } from '../lib/mindmap-style';

// Device-local mindmap view state: which nodes are collapsed, per map.
// Deliberately NOT synced — phone and desktop want different collapse states,
// and syncing a toggle per tap would spam the changelog for zero content value.
// Mirrored to localStorage (opaque node ids only — no content; the key is
// covered by panic-wipe's `gtd25-*` sweep and by wipeAllData).

const STORAGE_KEY = 'gtd25-mindmap-ui';

interface MindmapUiState {
  collapsed: Record<string, string[]>;
  /** The node the format toolbar acts on. Lives here because the canvas owns
   *  selection but the toolbar sits above it, outside the canvas. Not persisted. */
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  /** Toolbar hovering a preset: drawn on the selected node, never stored. */
  stylePreview: NodeStylePatch | null;
  setStylePreview: (patch: NodeStylePatch | null) => void;
  toggleCollapsed: (mapId: string, nodeId: string) => void;
  isCollapsed: (mapId: string, nodeId: string) => boolean;
  expand: (mapId: string, nodeId: string) => void;
  /** Drop stored state for maps that no longer exist (called on purge). */
  pruneMaps: (liveMapIds: Set<string>) => void;
}

function loadInitial(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, string[]> = {};
    for (const [mapId, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) result[mapId] = ids.filter((id): id is string => typeof id === 'string');
    }
    return result;
  } catch {
    return {};
  }
}

function persist(collapsed: Record<string, string[]>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
  } catch { /* storage full/unavailable — collapse state is best-effort */ }
}

export const useMindmapUi = create<MindmapUiState>((set, get) => ({
  collapsed: loadInitial(),
  selectedNodeId: null,
  setSelectedNodeId: (id) => set((s) => (s.selectedNodeId === id ? s : { selectedNodeId: id, stylePreview: null })),
  stylePreview: null,
  setStylePreview: (patch) => set({ stylePreview: patch }),
  toggleCollapsed: (mapId, nodeId) =>
    set((state) => {
      const current = state.collapsed[mapId] ?? [];
      const next = current.includes(nodeId)
        ? current.filter((id) => id !== nodeId)
        : [...current, nodeId];
      const collapsed = { ...state.collapsed, [mapId]: next };
      if (next.length === 0) delete collapsed[mapId];
      persist(collapsed);
      return { collapsed };
    }),
  isCollapsed: (mapId, nodeId) => (get().collapsed[mapId] ?? []).includes(nodeId),
  expand: (mapId, nodeId) =>
    set((state) => {
      const current = state.collapsed[mapId] ?? [];
      if (!current.includes(nodeId)) return state;
      const next = current.filter((id) => id !== nodeId);
      const collapsed = { ...state.collapsed, [mapId]: next };
      if (next.length === 0) delete collapsed[mapId];
      persist(collapsed);
      return { collapsed };
    }),
  pruneMaps: (liveMapIds) =>
    set((state) => {
      const collapsed: Record<string, string[]> = {};
      for (const [mapId, ids] of Object.entries(state.collapsed)) {
        if (liveMapIds.has(mapId)) collapsed[mapId] = ids;
      }
      persist(collapsed);
      return { collapsed };
    }),
}));
