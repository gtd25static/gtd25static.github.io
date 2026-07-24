import type { LayoutRect, MindmapLayout } from './mindmap-layout';

// Motion for the mindmap canvas. Everything on screen — node boxes, edge
// curves, the action buttons, the collapse toggles — is derived from one
// MindmapLayout, so animating that single object animates the whole map
// coherently. Interpolating in JS (rather than CSS transitions on the SVG)
// is what lets the edges follow: a path's `d` is not reliably transitionable,
// but recomputing endpoints from interpolated boxes always is.

// Durations are deliberately short (user-tuned): the earlier 360/340/270ms
// tuning was compensating for a bug that hid the animations entirely — once
// visible, it read as sluggish. Keep the three in step if retuning.
/** Node boxes gliding to their new places after a re-layout. */
export const LAYOUT_MS = 90;
/** A node appearing (expand, create). */
export const ENTER_MS = 85;
/** A node leaving (collapse, delete) — quicker, exits shouldn't hold you up. */
export const EXIT_MS = 70;

// Strength of the settle overshoot on the tail (larger = more bounce past the
// target before it settles). 1.7 ≈ a ~5% overshoot of the move distance.
const SETTLE = 1.7;

/**
 * A glide with a slow start and a small settle bounce. Deliberately NOT an
 * ease-out (those are ~80% done in the first third, which reads as an abrupt
 * snap): the first half eases in — a slow start, no backward "wind-up" — and the
 * second half is an easeOutBack that rises slightly PAST the target then settles
 * back onto it, giving the motion a soft landing. Can return > 1 (the overshoot);
 * lerpLayout must not clamp it. Kept in sync with --mm-ease-glide in
 * styles/index.css.
 */
export function easeGlide(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t < 0.5) return 4 * t * t * t; // ease-in, reaches 0.5 at t=0.5, f'(0)=0
  const u = 2 * t - 1;               // remap [0.5,1] → [0,1]
  const b = 1 + (SETTLE + 1) * (u - 1) ** 3 + SETTLE * (u - 1) ** 2; // easeOutBack, overshoots then settles to 1
  return 0.5 + 0.5 * b;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lerpRect(from: LayoutRect, to: LayoutRect, t: number): LayoutRect {
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    w: lerp(from.w, to.w, t),
    h: lerp(from.h, to.h, t),
  };
}

/**
 * `from` drawn `t` of the way towards `to`. `t` can exceed 1 — that is the
 * settle overshoot from easeGlide, and it must extrapolate (a box a little past
 * its target, on its way back), never be clamped away.
 *
 * A node with no `from` box just appeared (expand, create). Rather than
 * materialise at its final place, it glides out of the box it belongs under:
 * the nearest ancestor that was already on screen (usually the node that was
 * expanded, or the new node's parent). A revealed subtree therefore unfolds
 * from its parent instead of popping into existence. A brand-new node whose
 * ancestor also just appeared (no anchor to grow from) still starts in place.
 */
export function lerpLayout(from: MindmapLayout, to: MindmapLayout, t: number): MindmapLayout {
  if (t === 1) return to;

  // Parent of each node in the target, so an entering node can be traced up to
  // the on-screen box it should unfold from.
  const parentOf = new Map<string, string>();
  for (const e of to.edges) parentOf.set(e.toId, e.fromId);
  const unfoldFrom = (id: string): LayoutRect | undefined => {
    const seen = new Set<string>();
    let cur = parentOf.get(id);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const box = from.rects.get(cur);
      if (box) return box;
      cur = parentOf.get(cur);
    }
    return undefined;
  };

  const rects = new Map<string, LayoutRect>();
  for (const [id, target] of to.rects) {
    const start = from.rects.get(id) ?? unfoldFrom(id);
    rects.set(id, start ? lerpRect(start, target, t) : target);
  }

  // Endpoints are re-derived from the interpolated boxes (parent right-edge
  // midpoint → child left-edge midpoint), so an edge can never detach from the
  // node it connects mid-flight.
  const edges = to.edges.map((e) => {
    const parent = rects.get(e.fromId);
    const child = rects.get(e.toId);
    if (!parent || !child) return e;
    return {
      ...e,
      x1: parent.x + parent.w,
      y1: parent.y + parent.h / 2,
      x2: child.x,
      y2: child.y + child.h / 2,
    };
  });

  return {
    rects,
    edges,
    bounds: {
      minX: lerp(from.bounds.minX, to.bounds.minX, t),
      minY: lerp(from.bounds.minY, to.bounds.minY, t),
      maxX: lerp(from.bounds.maxX, to.bounds.maxX, t),
      maxY: lerp(from.bounds.maxY, to.bounds.maxY, t),
    },
  };
}
