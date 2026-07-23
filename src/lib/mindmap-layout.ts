import type { MindmapTree, MindmapTreeNode } from './mindmap-tree';

// Auto-layout for the mindmap canvas: strictly left-to-right (root at x=0,
// every child right of its parent — never bilateral), recursive subtree-extent
// stacking (the markmap/FreeMind approach). Children occupy disjoint vertical
// slots sized by their subtree extent, so overlap is impossible by construction;
// the parent centers on its children (or children on the parent when the parent
// is taller). O(n), handles variable per-node sizes natively.

export const H_GAP = 48; // px between a parent's right edge and a child's left edge
export const V_GAP = 12; // px between sibling subtree slots

export interface NodeSize { w: number; h: number }
export interface LayoutRect { x: number; y: number; w: number; h: number }

export interface LayoutEdge {
  fromId: string;
  toId: string;
  x1: number; y1: number; // parent right-edge midpoint
  x2: number; y2: number; // child left-edge midpoint
}

export interface MindmapLayout {
  rects: Map<string, LayoutRect>;
  edges: LayoutEdge[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const FALLBACK_SIZE: NodeSize = { w: 120, h: 36 };

export function layoutMindmap(
  tree: MindmapTree,
  sizes: Map<string, NodeSize>,
  collapsed: Set<string>,
): MindmapLayout {
  const rects = new Map<string, LayoutRect>();
  const edges: LayoutEdge[] = [];
  if (!tree.root) {
    return { rects, edges, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
  }

  const sizeOf = (id: string): NodeSize => sizes.get(id) ?? FALLBACK_SIZE;
  const visibleChildren = (n: MindmapTreeNode): MindmapTreeNode[] =>
    collapsed.has(n.node.id) ? [] : n.children;

  const extents = new Map<string, number>();
  const computeExtent = (n: MindmapTreeNode): number => {
    const own = sizeOf(n.node.id).h;
    const kids = visibleChildren(n);
    let extent = own;
    if (kids.length > 0) {
      const kidsTotal = kids.reduce((sum, k) => sum + computeExtent(k), 0) + V_GAP * (kids.length - 1);
      extent = Math.max(own, kidsTotal);
    }
    extents.set(n.node.id, extent);
    return extent;
  };
  computeExtent(tree.root);

  const place = (n: MindmapTreeNode, x: number, top: number) => {
    const { w, h } = sizeOf(n.node.id);
    const extent = extents.get(n.node.id)!;
    const kids = visibleChildren(n);

    if (kids.length === 0) {
      rects.set(n.node.id, { x, y: top + (extent - h) / 2, w, h });
      return;
    }

    const kidsTotal = kids.reduce((sum, k) => sum + extents.get(k.node.id)!, 0) + V_GAP * (kids.length - 1);
    // Children shorter than the node itself center on it; otherwise they fill
    // the slot from the top and the node centers between the outer children.
    let childTop = top + Math.max(0, (extent - kidsTotal) / 2);
    const childX = x + w + H_GAP;
    for (const kid of kids) {
      place(kid, childX, childTop);
      childTop += extents.get(kid.node.id)! + V_GAP;
    }

    const firstRect = rects.get(kids[0].node.id)!;
    const lastRect = rects.get(kids[kids.length - 1].node.id)!;
    const childrenCenter = (firstRect.y + firstRect.h / 2 + lastRect.y + lastRect.h / 2) / 2;
    // Clamp inside the slot so the node can't overlap a sibling's slot.
    const y = Math.min(Math.max(childrenCenter - h / 2, top), top + extent - h);
    rects.set(n.node.id, { x, y, w, h });
  };
  place(tree.root, 0, 0);

  const collectEdges = (n: MindmapTreeNode) => {
    const parentRect = rects.get(n.node.id)!;
    for (const kid of visibleChildren(n)) {
      const childRect = rects.get(kid.node.id)!;
      edges.push({
        fromId: n.node.id,
        toId: kid.node.id,
        x1: parentRect.x + parentRect.w,
        y1: parentRect.y + parentRect.h / 2,
        x2: childRect.x,
        y2: childRect.y + childRect.h / 2,
      });
      collectEdges(kid);
    }
  };
  collectEdges(tree.root);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects.values()) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { rects, edges, bounds: { minX, minY, maxX, maxY } };
}

/**
 * The same layout shifted vertically by `dy` (world units). Used to pin a node
 * in place across a collapse/expand so the map doesn't jump. `dy === 0` returns
 * the input untouched (no allocation), which is the common, unshifted case.
 */
export function translateLayoutY(layout: MindmapLayout, dy: number): MindmapLayout {
  if (dy === 0) return layout;
  const rects = new Map<string, LayoutRect>();
  for (const [id, r] of layout.rects) rects.set(id, { ...r, y: r.y + dy });
  const edges = layout.edges.map((e) => ({ ...e, y1: e.y1 + dy, y2: e.y2 + dy }));
  const { minX, minY, maxX, maxY } = layout.bounds;
  return { rects, edges, bounds: { minX, minY: minY + dy, maxX, maxY: maxY + dy } };
}

/** SVG path for a curved edge: cubic Bézier easing horizontally between the endpoints. */
export function edgePath(e: LayoutEdge): string {
  const dx = Math.max((e.x2 - e.x1) / 2, 16);
  return `M ${e.x1} ${e.y1} C ${e.x1 + dx} ${e.y1}, ${e.x2 - dx} ${e.y2}, ${e.x2} ${e.y2}`;
}
