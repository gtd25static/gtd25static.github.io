import type { LayoutRect } from './mindmap-layout';

// Geometry behind "the action buttons follow the mouse". Hover is resolved from
// pointer coordinates instead of DOM enter/leave events, because the auto-layout
// packs siblings only V_GAP (12px) apart: a node's buttons are painted over its
// neighbours, so DOM hit-testing would hand hover to whichever element happens
// to be on top and the pair would flicker while the pointer sits near the border.

/** Radius around an action button that still counts as "on the buttons". */
export const ACTION_HIT_R = 16;
/** Grace band around the hovered node's box, for the gaps between nodes. */
export const HOVER_PAD = 12;

export interface Point { x: number; y: number }

export interface NodeActionAnchors {
  addChild: Point;
  addSibling: Point | null; // the root has no siblings
  edit: Point;
  remove: Point | null; // the root is deleted from the browser, not here
}

/**
 * Where the four action buttons sit around a node box (world coordinates).
 *
 * All of them hug the right-hand side: siblings are stacked at the same x only
 * V_GAP apart, so anything centred above or below a node lands *inside* its
 * neighbour, while the H_GAP channel to the right is free until the children.
 */
export function nodeActionAnchors(
  rect: LayoutRect,
  { isRoot, hasToggle }: { isRoot: boolean; hasToggle: boolean },
): NodeActionAnchors {
  return {
    addChild: { x: rect.x + rect.w + (hasToggle ? 36 : 16), y: rect.y + rect.h / 2 },
    addSibling: isRoot ? null : { x: rect.x + rect.w + 14, y: rect.y + rect.h + 16 },
    edit: { x: rect.x + rect.w - 10, y: rect.y - 16 },
    remove: isRoot ? null : { x: rect.x + rect.w + 14, y: rect.y - 16 },
  };
}

export function anchorPoints(a: NodeActionAnchors): Point[] {
  return [a.addChild, a.addSibling, a.edit, a.remove].filter((p): p is Point => p !== null);
}

/**
 * Which node the pointer is hovering, given where it was hovering before.
 *
 * Priority — the first rule that matches wins:
 *  1. The open buttons of the current node: they are drawn on top of everything,
 *     so reaching for one never hands hover to the neighbour underneath.
 *  2. A node box containing the pointer (layout boxes never overlap, so this is
 *     unambiguous and switches immediately — no delay to feel sluggish).
 *  3. The current node's grace band, so crossing a 12px gap doesn't drop it.
 */
export function resolveHoverTarget(
  world: Point,
  rects: Map<string, LayoutRect>,
  current: { id: string; anchors: Point[] } | null,
): string | null {
  if (current && current.anchors.some((a) => Math.hypot(world.x - a.x, world.y - a.y) <= ACTION_HIT_R)) {
    return current.id;
  }

  for (const [id, r] of rects) {
    if (world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h) return id;
  }

  if (current) {
    const r = rects.get(current.id);
    if (
      r &&
      world.x >= r.x - HOVER_PAD && world.x <= r.x + r.w + HOVER_PAD &&
      world.y >= r.y - HOVER_PAD && world.y <= r.y + r.h + HOVER_PAD
    ) {
      return current.id;
    }
  }

  return null;
}
