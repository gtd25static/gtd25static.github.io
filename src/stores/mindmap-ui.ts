import { create } from 'zustand';
import type { CustomPalette, NodeStylePatch } from '../lib/mindmap-style';
import { isHexColor } from '../lib/mindmap-style';

// Device-local mindmap view state: which nodes are collapsed, per map, the
// user's saved colour presets, and whether new maps start with smart colouring
// on. None of it is synced: collapse state is per-device by design, a saved
// preset is only an authoring shortcut — applying one writes the literal colours
// onto the node, so a styled node looks the same on every device whether or not
// that device has the preset — and the smart-colouring default is an authoring
// preference, not map content (the map's own flag IS synced, like any setting).
// Deliberately NOT synced — phone and desktop want different collapse states,
// and syncing a toggle per tap would spam the changelog for zero content value.
// Mirrored to localStorage (opaque node ids only — no content; the key is
// covered by panic-wipe's `gtd25-*` sweep and by wipeAllData).

const STORAGE_KEY = 'gtd25-mindmap-ui';
export const MAX_CUSTOM_PALETTES = 12;

interface PersistedUi {
  collapsed: Record<string, string[]>;
  customPalettes: CustomPalette[];
  /** What the smart-colouring toggle was last set to — the seed for new maps. */
  smartColoringDefault: boolean;
}

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
  /** User-saved colour presets (device-local; applied as literal colours). */
  customPalettes: CustomPalette[];
  addCustomPalette: (palette: Omit<CustomPalette, 'id'>) => void;
  removeCustomPalette: (id: string) => void;
  /**
   * Smart colouring carries over to the NEXT map you create, not to maps that
   * already exist: turning it on once means every map you make from then on
   * starts with it on. Read at creation time and written onto the new map, so
   * the map still owns (and syncs) its own flag.
   */
  smartColoringDefault: boolean;
  setSmartColoringDefault: (on: boolean) => void;
  /** Collapse every node that has children / expand everything, for one map. */
  collapseAll: (mapId: string, parentIds: string[]) => void;
  expandAll: (mapId: string) => void;
  /** Drop stored state for maps that no longer exist (called on purge). */
  pruneMaps: (liveMapIds: Set<string>) => void;
}

function loadInitial(): PersistedUi {
  const empty: PersistedUi = { collapsed: {}, customPalettes: [], smartColoringDefault: false };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;
    // Pre-presets builds stored the collapsed map at the top level.
    const record = parsed as Record<string, unknown>;
    const collapsedSource = ('collapsed' in record ? record.collapsed : record) as Record<string, unknown>;
    const collapsed: Record<string, string[]> = {};
    if (collapsedSource && typeof collapsedSource === 'object') {
      for (const [mapId, ids] of Object.entries(collapsedSource)) {
        if (Array.isArray(ids)) collapsed[mapId] = ids.filter((id): id is string => typeof id === 'string');
      }
    }
    const customPalettes: CustomPalette[] = Array.isArray(record.customPalettes)
      ? (record.customPalettes as unknown[]).filter(isCustomPalette).slice(0, MAX_CUSTOM_PALETTES)
      : [];
    return { collapsed, customPalettes, smartColoringDefault: record.smartColoringDefault === true };
  } catch {
    return empty;
  }
}

function isCustomPalette(value: unknown): value is CustomPalette {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return typeof p.id === 'string' && typeof p.name === 'string' &&
    isHexColor(p.bg) && isHexColor(p.fg) && isHexColor(p.border);
}

function persist(state: PersistedUi) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* storage full/unavailable — view state is best-effort */ }
}

/**
 * Write every durable slice, overriding the one this setter just changed. Going
 * through here (rather than hand-listing fields per setter) is what stops a new
 * slice from being silently dropped by the next unrelated toggle.
 */
function persistWith(state: MindmapUiState, changed: Partial<PersistedUi>) {
  persist({
    collapsed: state.collapsed,
    customPalettes: state.customPalettes,
    smartColoringDefault: state.smartColoringDefault,
    ...changed,
  });
}

export const useMindmapUi = create<MindmapUiState>((set, get) => ({
  ...loadInitial(),
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
      persistWith(state, { collapsed });
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
      persistWith(state, { collapsed });
      return { collapsed };
    }),
  collapseAll: (mapId, parentIds) =>
    set((state) => {
      const collapsed = { ...state.collapsed, [mapId]: [...parentIds] };
      if (parentIds.length === 0) delete collapsed[mapId];
      persistWith(state, { collapsed });
      return { collapsed };
    }),
  expandAll: (mapId) =>
    set((state) => {
      if (!state.collapsed[mapId]) return state;
      const collapsed = { ...state.collapsed };
      delete collapsed[mapId];
      persistWith(state, { collapsed });
      return { collapsed };
    }),
  addCustomPalette: (palette) =>
    set((state) => {
      if (state.customPalettes.length >= MAX_CUSTOM_PALETTES) return state;
      if (!isHexColor(palette.bg) || !isHexColor(palette.fg) || !isHexColor(palette.border)) return state;
      const customPalettes = [
        ...state.customPalettes,
        { ...palette, name: palette.name.trim().slice(0, 24) || 'Custom', id: `c${Date.now().toString(36)}${state.customPalettes.length}` },
      ];
      persistWith(state, { customPalettes });
      return { customPalettes };
    }),
  removeCustomPalette: (id) =>
    set((state) => {
      const customPalettes = state.customPalettes.filter((p) => p.id !== id);
      if (customPalettes.length === state.customPalettes.length) return state;
      persistWith(state, { customPalettes });
      return { customPalettes };
    }),
  setSmartColoringDefault: (on) =>
    set((state) => {
      if (state.smartColoringDefault === on) return state;
      persistWith(state, { smartColoringDefault: on });
      return { smartColoringDefault: on };
    }),
  pruneMaps: (liveMapIds) =>
    set((state) => {
      const collapsed: Record<string, string[]> = {};
      for (const [mapId, ids] of Object.entries(state.collapsed)) {
        if (liveMapIds.has(mapId)) collapsed[mapId] = ids;
      }
      persistWith(state, { collapsed });
      return { collapsed };
    }),
}));
