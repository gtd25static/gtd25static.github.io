import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MindmapNode } from '../../db/models';
import { buildTree, descendantIds } from '../../lib/mindmap-tree';
import { layoutMindmap, type LayoutRect, type NodeSize } from '../../lib/mindmap-layout';
import { anchorPoints, nodeActionAnchors, resolveHoverTarget } from '../../lib/mindmap-hover';
import { useAnimatedLayout } from '../../hooks/use-animated-layout';
import {
  useMindmapNodes,
  createMindmapNode,
  updateMindmapNodeLabel,
  reparentMindmapNode,
  deleteMindmapNodeSubtree,
  restoreMindmapNodeSubtree,
} from '../../hooks/use-mindmaps';
import { toast } from '../ui/Toast';
import { useMindmapUi } from '../../stores/mindmap-ui';
import { MindmapNodeView } from './MindmapNodeView';
import { MindmapEdges } from './MindmapEdges';
import { confirmDialog } from '../ui/ConfirmDialog';
import { mdToPlainText } from '../../lib/mini-markdown';

interface Viewport { tx: number; ty: number; k: number }

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const DRAG_THRESHOLD_PX = 8;
// Double-click/tap to edit is detected from our own pointer events rather than
// the DOM's dblclick: the svg captures the pointer on node press, which
// retargets the compatibility mouse events (click/dblclick) to the <svg>, so a
// handler on the node box never fires. Tracking taps by node id also survives
// the first click re-laying out the map (selecting un-clamps a long label).
const DOUBLE_TAP_MS = 400;
// A deleted subtree is only a click away from coming back — the default toast
// window (4s floor for undo toasts) is short for "did I just delete the wrong node?".
const UNDO_TOAST_MS = 8000;

// The interactive mindmap canvas: one <svg> whose world lives in a single
// translated+scaled <g>. All gestures are raw pointer events (dnd-kit is
// list-oriented and doesn't fit a free canvas):
//   background drag = pan · wheel = zoom at cursor · two pointers = pinch
//   node drag past 8px = re-parent (ghost + drop-target ring; the root, the
//   node itself and its descendants are not valid targets) · tap = select ·
//   double-click / double-tap / F2 = edit label inline · press anywhere outside
//   the open editor = commit and leave edit mode.
// The per-node action buttons follow the mouse (see mindmap-hover.ts) and fall
// back to the selected node, which is what touch — no hover — and the keyboard use.
export function MindmapCanvas({ mapId, background }: { mapId: string; background?: string }) {
  const nodes = useMindmapNodes(mapId);
  const collapsedArr = useMindmapUi((s) => s.collapsed[mapId]);
  const collapsedSet = useMemo(() => new Set(collapsedArr ?? []), [collapsedArr]);
  const toggleCollapsed = useMindmapUi((s) => s.toggleCollapsed);
  const expandNode = useMindmapUi((s) => s.expand);

  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const parentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tn of tree.byId.values()) {
      if (tn.children.length > 0) ids.add(tn.node.id);
    }
    return ids;
  }, [tree]);
  const parentOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const tn of tree.byId.values()) {
      for (const child of tn.children) map.set(child.node.id, tn.node.id);
    }
    return map;
  }, [tree]);

  const [sizes, setSizes] = useState<Map<string, NodeSize>>(new Map());
  const onMeasure = useCallback((id: string, size: NodeSize) => {
    setSizes((prev) => {
      const cur = prev.get(id);
      if (cur && Math.abs(cur.w - size.w) < 1 && Math.abs(cur.h - size.h) < 1) return prev;
      const next = new Map(prev);
      next.set(id, size);
      return next;
    });
  }, []);

  const targetLayout = useMemo(() => layoutMindmap(tree, sizes, collapsedSet), [tree, sizes, collapsedSet]);
  // Motion only starts once the map has been laid out and fitted, so opening a
  // map doesn't animate every node in from wherever it was first measured.
  const [motionReady, setMotionReady] = useState(false);
  const { layout, exiting } = useAnimatedLayout(targetLayout, motionReady);

  const [viewport, setViewport] = useState<Viewport>({ tx: 40, ty: 40, k: 1 });
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // Selection lives in the store: the format toolbar is a row of the editor,
  // above this component, and acts on whatever is selected here.
  const selectedId = useMindmapUi((s) => s.selectedNodeId);
  const setSelectedId = useMindmapUi((s) => s.setSelectedNodeId);
  const stylePreview = useMindmapUi((s) => s.stylePreview);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  hoveredIdRef.current = hoveredId;
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  editingIdRef.current = editingId;

  const [drag, setDrag] = useState<{ id: string; x: number; y: number; targetId: string | null } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const panRef = useRef<{ pointerId: number; sx: number; sy: number; tx0: number; ty0: number; moved: boolean } | null>(null);
  const pinchRef = useRef<{ d0: number; cx0: number; cy0: number; wx0: number; wy0: number; k0: number } | null>(null);
  const dragRef = useRef<{ id: string; sx: number; sy: number; active: boolean; forbidden: Set<string> } | null>(null);
  const lastTapRef = useRef<{ id: string; t: number; x: number; y: number } | null>(null);
  const rowCacheRef = useRef(new Map<string, MindmapNode>());
  const lastActionsRef = useRef<{ rect: LayoutRect; row: MindmapNode } | null>(null);

  // Refs the gesture handlers read without re-binding
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const treeRef = useRef(tree);
  treeRef.current = tree;

  useEffect(() => () => setSelectedId(null), [mapId, setSelectedId]);

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const { tx, ty, k } = viewportRef.current;
    const bounds = svg?.getBoundingClientRect();
    const x = clientX - (bounds?.left ?? 0);
    const y = clientY - (bounds?.top ?? 0);
    return { x: (x - tx) / k, y: (y - ty) / k };
  }, []);

  // --- Zoom (wheel must be a non-passive native listener to preventDefault) ---
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { tx, ty, k } = viewportRef.current;
      const bounds = svg.getBoundingClientRect();
      const sx = e.clientX - bounds.left;
      const sy = e.clientY - bounds.top;
      const k2 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k * Math.exp(-e.deltaY * 0.0015)));
      setViewport({
        tx: sx - ((sx - tx) / k) * k2,
        ty: sy - ((sy - ty) / k) * k2,
        k: k2,
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const { tx, ty, k } = viewportRef.current;
    const bounds = svg.getBoundingClientRect();
    const sx = bounds.width / 2;
    const sy = bounds.height / 2;
    const k2 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k * factor));
    setViewport({ tx: sx - ((sx - tx) / k) * k2, ty: sy - ((sy - ty) / k) * k2, k: k2 });
  }, []);

  const zoomToFit = useCallback(() => {
    const svg = svgRef.current;
    const { bounds } = layoutRef.current;
    if (!svg) return;
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    if (bw <= 0 || bh <= 0) return;
    const rect = svg.getBoundingClientRect();
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((rect.width - 80) / bw, (rect.height - 80) / bh, 1.25)));
    setViewport({
      tx: (rect.width - bw * k) / 2 - bounds.minX * k,
      ty: (rect.height - bh * k) / 2 - bounds.minY * k,
      k,
    });
  }, []);

  // Fit once the first real layout exists.
  const didFitRef = useRef(false);
  useEffect(() => {
    if (!didFitRef.current && layout.rects.size > 0 && sizes.size > 0) {
      didFitRef.current = true;
      zoomToFit();
      const raf = requestAnimationFrame(() => setMotionReady(true));
      return () => cancelAnimationFrame(raf);
    }
  }, [layout, sizes, zoomToFit]);

  // --- Node actions ---

  const startEdit = useCallback((id: string) => {
    setSelectedId(id);
    setEditingId(id);
  }, [setSelectedId]);

  const commitEdit = useCallback((id: string, label: string) => {
    if (editingIdRef.current !== id) return; // blur after Enter already committed
    setEditingId(null);
    const trimmed = label.trim();
    if (trimmed) void updateMindmapNodeLabel(id, trimmed);
  }, []);

  const cancelEdit = useCallback(() => setEditingId(null), []);

  const addChild = useCallback(async (parentId: string) => {
    expandNode(mapId, parentId);
    const node = await createMindmapNode(mapId, parentId);
    if (node) startEdit(node.id);
  }, [mapId, expandNode, startEdit]);

  const addSibling = useCallback(async (nodeId: string) => {
    const row = nodesById.get(nodeId);
    if (!row?.parentId) return; // the root has no siblings
    const node = await createMindmapNode(mapId, row.parentId);
    if (node) startEdit(node.id);
  }, [mapId, nodesById, startEdit]);

  const deleteSubtree = useCallback(async (id: string) => {
    const row = nodesById.get(id);
    if (!row?.parentId) return; // root: delete the map from the browser instead
    const count = descendantIds(treeRef.current, id).size;
    if (count > 0) {
      const ok = await confirmDialog(
        `Delete this node and its ${count} descendant node(s)? Recoverable only until the map's next 30-day purge.`,
        { confirmLabel: 'Delete', danger: true },
      );
      if (!ok) return;
    }
    setSelectedId(row.parentId);
    setEditingId(null);
    setHoveredId(null); // the node under the pointer is about to vanish
    const deleted = await deleteMindmapNodeSubtree(id);
    if (deleted.length === 0) return;
    toast(
      deleted.length > 1 ? `${deleted.length} nodes deleted` : 'Node deleted',
      'info',
      () => void restoreMindmapNodeSubtree(deleted),
      UNDO_TOAST_MS,
    );
  }, [nodesById, setSelectedId]);

  // --- Pointer gestures ---

  const onNodePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if (editingIdRef.current) return;
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    try { svg.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2) {
      dragRef.current = null;
      setDrag(null);
      startPinch();
      return;
    }
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, active: false, forbidden: new Set() };
  }, []);

  const startPinch = () => {
    const pts = [...pointersRef.current.values()];
    if (pts.length < 2) return;
    const svg = svgRef.current;
    const bounds = svg?.getBoundingClientRect();
    const { tx, ty, k } = viewportRef.current;
    const cx = (pts[0].x + pts[1].x) / 2 - (bounds?.left ?? 0);
    const cy = (pts[0].y + pts[1].y) / 2 - (bounds?.top ?? 0);
    pinchRef.current = {
      d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
      cx0: cx,
      cy0: cy,
      wx0: (cx - tx) / k,
      wy0: (cy - ty) / k,
      k0: k,
    };
    panRef.current = null;
  };

  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    try { svg.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    containerRef.current?.focus();
    if (pointersRef.current.size >= 2) {
      startPinch();
      return;
    }
    const { tx, ty } = viewportRef.current;
    panRef.current = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, tx0: tx, ty0: ty, moved: false };
  };

  // Mouse-only: touch has no hover, and during a gesture (drag/pan/pinch) or an
  // inline edit the actions are hidden anyway.
  const updateHover = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    if (editingIdRef.current || dragRef.current || panRef.current || pinchRef.current) return;
    const currentId = hoveredIdRef.current;
    const currentRect = currentId ? layout.rects.get(currentId) : undefined;
    const current = currentId && currentRect
      ? {
          id: currentId,
          anchors: anchorPoints(nodeActionAnchors(currentRect, {
            isRoot: !nodesById.get(currentId)?.parentId,
            hasToggle: parentIds.has(currentId),
          })),
        }
      : null;
    const next = resolveHoverTarget(screenToWorld(e.clientX, e.clientY), layout.rects, current);
    if (next !== currentId) setHoveredId(next);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    updateHover(e);
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()];
      const svg = svgRef.current;
      const bounds = svg?.getBoundingClientRect();
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const cx = (pts[0].x + pts[1].x) / 2 - (bounds?.left ?? 0);
      const cy = (pts[0].y + pts[1].y) / 2 - (bounds?.top ?? 0);
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.k0 * (d / Math.max(pinch.d0, 1))));
      setViewport({ tx: cx - pinch.wx0 * k, ty: cy - pinch.wy0 * k, k });
      return;
    }

    const dragState = dragRef.current;
    if (dragState) {
      if (!dragState.active) {
        if (Math.hypot(e.clientX - dragState.sx, e.clientY - dragState.sy) < DRAG_THRESHOLD_PX) return;
        const row = nodesById.get(dragState.id);
        if (!row?.parentId) return; // the root doesn't drag
        dragState.active = true;
        dragState.forbidden = new Set([dragState.id, ...descendantIds(treeRef.current, dragState.id)]);
      }
      const world = screenToWorld(e.clientX, e.clientY);
      let targetId: string | null = null;
      for (const [id, rect] of layoutRef.current.rects) {
        if (dragState.forbidden.has(id)) continue;
        if (world.x >= rect.x && world.x <= rect.x + rect.w && world.y >= rect.y && world.y <= rect.y + rect.h) {
          targetId = id;
          break;
        }
      }
      setDrag({ id: dragState.id, x: world.x, y: world.y, targetId });
      return;
    }

    const pan = panRef.current;
    if (pan && pan.pointerId === e.pointerId) {
      const dx = e.clientX - pan.sx;
      const dy = e.clientY - pan.sy;
      if (Math.hypot(dx, dy) > 3) pan.moved = true;
      setViewport((v) => ({ ...v, tx: pan.tx0 + dx, ty: pan.ty0 + dy }));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);

    if (pinchRef.current) {
      if (pointersRef.current.size < 2) pinchRef.current = null;
      return;
    }

    const dragState = dragRef.current;
    if (dragState) {
      dragRef.current = null;
      if (dragState.active) {
        const dropTarget = drag?.targetId ?? null;
        setDrag(null);
        if (dropTarget) {
          expandNode(mapId, dropTarget);
          void reparentMindmapNode(dragState.id, dropTarget);
        }
      } else {
        setSelectedId(dragState.id);
        containerRef.current?.focus();
        const last = lastTapRef.current;
        const now = Date.now();
        if (
          last && last.id === dragState.id && now - last.t <= DOUBLE_TAP_MS &&
          Math.hypot(e.clientX - last.x, e.clientY - last.y) < DRAG_THRESHOLD_PX
        ) {
          lastTapRef.current = null;
          startEdit(dragState.id);
        } else {
          lastTapRef.current = { id: dragState.id, t: now, x: e.clientX, y: e.clientY };
        }
      }
      return;
    }

    const pan = panRef.current;
    if (pan && pan.pointerId === e.pointerId) {
      panRef.current = null;
      if (!pan.moved) {
        setSelectedId(null);
        setEditingId(null);
      }
    }
  };

  // --- Keyboard ---

  const navigate = (dir: 'left' | 'right' | 'up' | 'down') => {
    const currentId = selectedId ?? tree.root?.node.id;
    if (!currentId) return;
    if (!selectedId) {
      setSelectedId(currentId);
      return;
    }
    const treeNode = tree.byId.get(currentId);
    if (!treeNode) return;
    if (dir === 'left') {
      const parent = parentOf.get(currentId);
      if (parent) setSelectedId(parent);
    } else if (dir === 'right') {
      if (treeNode.children.length > 0) {
        expandNode(mapId, currentId);
        setSelectedId(treeNode.children[0].node.id);
      }
    } else {
      const parentId = parentOf.get(currentId);
      const siblings = parentId ? tree.byId.get(parentId)!.children : [];
      const idx = siblings.findIndex((s) => s.node.id === currentId);
      const next = dir === 'up' ? siblings[idx - 1] : siblings[idx + 1];
      if (next) setSelectedId(next.node.id);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editingIdRef.current) return; // the textarea handles its own keys
    // A stale hover would keep the actions on a node the keyboard just left.
    if (hoveredIdRef.current) setHoveredId(null);
    const sel = selectedId;
    switch (e.key) {
      case 'Enter':
        if (sel) { e.preventDefault(); void addSibling(sel); }
        break;
      case 'Tab':
        if (sel) { e.preventDefault(); void addChild(sel); }
        break;
      case 'F2':
        if (sel) { e.preventDefault(); startEdit(sel); }
        break;
      case 'Delete':
      case 'Backspace':
        if (sel) { e.preventDefault(); void deleteSubtree(sel); }
        break;
      case ' ':
        if (sel && parentIds.has(sel)) { e.preventDefault(); toggleCollapsed(mapId, sel); }
        break;
      case 'Escape':
        setSelectedId(null);
        break;
      case 'ArrowLeft': e.preventDefault(); navigate('left'); break;
      case 'ArrowRight': e.preventDefault(); navigate('right'); break;
      case 'ArrowUp': e.preventDefault(); navigate('up'); break;
      case 'ArrowDown': e.preventDefault(); navigate('down'); break;
    }
  };

  // Visible nodes = those the layout placed (collapsed subtrees are excluded);
  // unmeasured nodes render invisibly so they can report a size.
  const visibleNodes: MindmapNode[] = [];
  const hiddenUnmeasured: MindmapNode[] = [];
  for (const n of nodes) {
    if (layout.rects.has(n.id)) visibleNodes.push(n);
    else if (!sizes.has(n.id)) hiddenUnmeasured.push(n);
  }

  // Rows for the nodes on their way out (collapsed, or deleted — those are
  // already gone from `nodes`, so the last version of each row is kept around).
  const rowCache = rowCacheRef.current;
  for (const n of nodes) rowCache.set(n.id, n);
  for (const id of rowCache.keys()) {
    if (!nodesById.has(id) && !exiting.has(id)) rowCache.delete(id);
  }

  // Hover wins over selection: the buttons sit on the node under the mouse.
  const actionsId = hoveredId ?? selectedId;
  const actionsRect = actionsId ? layout.rects.get(actionsId) : undefined;
  const actionsRow = actionsId ? nodesById.get(actionsId) : undefined;
  const actionsOpen = !!(actionsRect && actionsRow) && !editingId && !drag;
  if (actionsOpen) lastActionsRef.current = { rect: actionsRect!, row: actionsRow! };
  // Closed buttons stay mounted (invisible, inert) only while animating, so
  // they have something to animate out from.
  const actions = actionsOpen
    ? { rect: actionsRect!, row: actionsRow! }
    : motionReady ? lastActionsRef.current : null;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative flex-1 overflow-hidden outline-none"
      style={background ? { background } : undefined}
      data-testid="mindmap-canvas"
    >
      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'none' }}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHoveredId(null)}
      >
        <g transform={`translate(${viewport.tx},${viewport.ty}) scale(${viewport.k})`}>
          <MindmapEdges
            layout={layout}
            parentIds={parentIds}
            collapsed={collapsedSet}
            onToggle={(id) => toggleCollapsed(mapId, id)}
          />
          {visibleNodes.map((n) => (
            <MindmapNodeView
              key={n.id}
              node={n}
              rect={layout.rects.get(n.id)}
              selected={n.id === selectedId}
              hovered={n.id === hoveredId}
              editing={n.id === editingId}
              isRoot={tree.root?.node.id === n.id}
              isDragSource={drag?.id === n.id}
              isDropTarget={drag?.targetId === n.id}
              animateIn={motionReady}
              stylePreview={n.id === selectedId ? stylePreview : null}
              onMeasure={onMeasure}
              onPointerDown={onNodePointerDown}
              onCommitEdit={commitEdit}
              onCancelEdit={cancelEdit}
            />
          ))}
          {[...exiting].map(([id, rect]) => {
            const row = rowCache.get(id);
            return row ? (
              <MindmapNodeView
                key={`leaving-${id}`}
                node={row}
                rect={rect}
                selected={false}
                hovered={false}
                editing={false}
                isRoot={false}
                isDragSource={false}
                isDropTarget={false}
                animateIn={false}
                leaving
                onMeasure={onMeasure}
                onPointerDown={onNodePointerDown}
                onCommitEdit={commitEdit}
                onCancelEdit={cancelEdit}
              />
            ) : null;
          })}
          {hiddenUnmeasured.map((n) => (
            <MindmapNodeView
              key={n.id}
              node={n}
              rect={undefined}
              selected={false}
              hovered={false}
              editing={false}
              isRoot={false}
              isDragSource={false}
              isDropTarget={false}
              animateIn={false}
              onMeasure={onMeasure}
              onPointerDown={onNodePointerDown}
              onCommitEdit={commitEdit}
              onCancelEdit={cancelEdit}
            />
          ))}
          {actions && (
            <NodeActions
              rect={actions.rect}
              open={actionsOpen}
              isRoot={!actions.row.parentId}
              hasToggle={parentIds.has(actions.row.id)}
              onAddChild={() => void addChild(actions.row.id)}
              onAddSibling={() => void addSibling(actions.row.id)}
              onEdit={() => startEdit(actions.row.id)}
              onDelete={() => void deleteSubtree(actions.row.id)}
            />
          )}
          {drag && (
            <g transform={`translate(${drag.x + 14},${drag.y + 14})`} className="pointer-events-none opacity-75">
              <rect width={150} height={32} rx={10} className="fill-accent-50 stroke-accent-500 dark:fill-accent-900" strokeWidth={1.5} />
              <text x={10} y={20} className="fill-zinc-700 text-xs dark:fill-zinc-200">
                {truncate(mdToPlainText(nodesById.get(drag.id)?.label ?? ''), 20)}
              </text>
            </g>
          )}
        </g>
      </svg>

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-400">
          This map has no nodes.
        </div>
      )}

      {/* Floating zoom controls */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-1 rounded-xl border border-zinc-200 bg-white/90 p-1 shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-zinc-800/90">
        <CanvasButton label="Zoom in" onClick={() => zoomBy(1.25)}>+</CanvasButton>
        <CanvasButton label="Zoom out" onClick={() => zoomBy(0.8)}>−</CanvasButton>
        <CanvasButton label="Fit map" onClick={zoomToFit}>⤢</CanvasButton>
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function CanvasButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-10 w-10 md:h-8 md:w-8 items-center justify-center rounded-lg text-lg text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
    >
      {children}
    </button>
  );
}

function NodeActions({ rect, open, isRoot, hasToggle, onAddChild, onAddSibling, onEdit, onDelete }: {
  rect: LayoutRect;
  /** False while the group animates out — kept mounted, invisible and inert. */
  open: boolean;
  isRoot: boolean;
  hasToggle: boolean;
  onAddChild: () => void;
  onAddSibling: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const a = nodeActionAnchors(rect, { isRoot, hasToggle });
  return (
    <g
      className={`mm-actions ${open ? '' : 'mm-actions-closed'}`}
      // Grow out of the node's right edge, not the canvas origin
      style={{ transformOrigin: `${rect.x + rect.w}px ${rect.y + rect.h / 2}px` }}
      aria-hidden={!open}
    >
      <ActionButton x={a.addChild.x} y={a.addChild.y} title="Add child (Tab)" onActivate={onAddChild}>
        <PlusIcon />
      </ActionButton>
      {a.addSibling && (
        <ActionButton x={a.addSibling.x} y={a.addSibling.y} title="Add sibling (Enter)" onActivate={onAddSibling}>
          <PlusIcon />
        </ActionButton>
      )}
      <ActionButton x={a.edit.x} y={a.edit.y} title="Edit (F2 / double-tap)" onActivate={onEdit}>
        <path d="M -3.5 3.5 L 3 -3 L 4.5 -1.5 L -2 5 L -4 5.2 Z M 2.2 -4.2 L 3.8 -2.6" className="fill-none stroke-accent-600 dark:stroke-accent-400" strokeWidth={1.3} strokeLinejoin="round" />
      </ActionButton>
      {a.remove && (
        <ActionButton x={a.remove.x} y={a.remove.y} title="Delete (Del)" danger onActivate={onDelete}>
          <path d="M -3.5 -3 H 3.5 M -2.5 -3 V 4 a 1 1 0 0 0 1 1 h 3 a 1 1 0 0 0 1 -1 V -3 M -1 -3 V -4.2 H 1 V -3 M -1 -1 V 3 M 1 -1 V 3" className="fill-none stroke-red-500" strokeWidth={1.2} strokeLinecap="round" />
        </ActionButton>
      )}
    </g>
  );
}

function PlusIcon() {
  return <path d="M -4 0 H 4 M 0 -4 V 4" className="stroke-accent-600 dark:stroke-accent-400" strokeWidth={1.6} strokeLinecap="round" />;
}

function ActionButton({ x, y, title, danger, onActivate, children }: {
  x: number;
  y: number;
  title: string;
  danger?: boolean;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  return (
    <g
      transform={`translate(${x},${y})`}
      className="cursor-pointer"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onActivate(); }}
    >
      <title>{title}</title>
      {/* Invisible target, kept just above the visible r=11 disc: the buttons
          float over the neighbours, so a wider one would swallow their taps. */}
      <circle r={14} fill="transparent" />
      <circle
        r={11}
        className={danger
          ? 'fill-red-50 stroke-red-400 dark:fill-red-950'
          : 'fill-white stroke-accent-400 dark:fill-zinc-800 dark:stroke-accent-500'}
        strokeWidth={1.5}
      />
      {children}
    </g>
  );
}
