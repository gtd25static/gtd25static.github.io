import type { LayoutRect, MindmapLayout } from './mindmap-layout';

// Motion for the mindmap canvas. Everything on screen — node boxes, edge
// curves, the action buttons, the collapse toggles — is derived from one
// MindmapLayout, so animating that single object animates the whole map
// coherently. Interpolating in JS (rather than CSS transitions on the SVG)
// is what lets the edges follow: a path's `d` is not reliably transitionable,
// but recomputing endpoints from interpolated boxes always is.

/** Node boxes gliding to their new places after a re-layout. */
export const LAYOUT_MS = 190;
/** A node appearing (expand, create). */
export const ENTER_MS = 170;
/** A node leaving (collapse, delete) — quicker, exits shouldn't hold you up. */
export const EXIT_MS = 130;

/**
 * easeOutBack with a deliberately tiny overshoot (~2.3%), i.e. a hint of bounce
 * rather than a bounce. Kept in sync with --mm-ease-bounce in styles/index.css.
 */
export function easeOutBackTiny(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c = 0.8;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
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
 * `from` drawn `t` of the way towards `to`. `t` may exceed 1 — that is the
 * overshoot from the easing above, and it must not be clamped away.
 * Nodes with no `from` box (they just appeared) start at their final place;
 * their entrance is the node box's own scale-in.
 */
export function lerpLayout(from: MindmapLayout, to: MindmapLayout, t: number): MindmapLayout {
  if (t === 1) return to;

  const rects = new Map<string, LayoutRect>();
  for (const [id, target] of to.rects) {
    const start = from.rects.get(id);
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
