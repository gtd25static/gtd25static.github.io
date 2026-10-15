import { V_GAP, type LayoutRect } from './mindmap-layout';
import type { Point } from './mindmap-hover';

// Where a dragged node lands. Each node box is split in three bands: the top
// quarter drops the node *before* it (as a sibling), the bottom quarter *after*
// it, and the middle makes it a *child* (the original re-parent gesture). The
// half-gap above and below each box belongs to its edge band, so the 12px gap
// between two siblings is a target too — without it a reorder would need a
// ~9px-tall aim. The root has no siblings: all of it means "child".

export type DropPosition = 'before' | 'after' | 'child';

export interface DropTarget {
  id: string;
  position: DropPosition;
}

const EDGE_FRACTION = 0.25;

export function resolveDropTarget(
  p: Point,
  rects: Map<string, LayoutRect>,
  forbidden: Set<string>,
  rootId: string | undefined,
): DropTarget | null {
  for (const [id, r] of rects) {
    if (forbidden.has(id)) continue;
    if (p.x < r.x || p.x > r.x + r.w) continue;
    if (p.y < r.y - V_GAP / 2 || p.y > r.y + r.h + V_GAP / 2) continue;
    if (id === rootId) {
      if (p.y < r.y || p.y > r.y + r.h) continue; // no gap band around the root
      return { id, position: 'child' };
    }
    if (p.y < r.y + r.h * EDGE_FRACTION) return { id, position: 'before' };
    if (p.y > r.y + r.h * (1 - EDGE_FRACTION)) return { id, position: 'after' };
    return { id, position: 'child' };
  }
  return null;
}

/** World y of the insertion line for a before/after drop: mid-gap next to the node. */
export function dropLineY(r: LayoutRect, position: 'before' | 'after'): number {
  return position === 'before' ? r.y - V_GAP / 2 : r.y + r.h + V_GAP / 2;
}
