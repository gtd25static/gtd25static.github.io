import { useEffect, useReducer, useRef } from 'react';
import type { LayoutRect, MindmapLayout } from '../lib/mindmap-layout';
import {
  EXIT_MS,
  LAYOUT_MS,
  easeGlide,
  lerpLayout,
  prefersReducedMotion,
} from '../lib/mindmap-motion';

const NO_EXITS: ReadonlyMap<string, LayoutRect> = new Map();

export interface AnimatedLayout {
  /** What to draw this frame: the previous layout gliding towards `target`. */
  layout: MindmapLayout;
  /** Nodes that just left, held at their last box while they animate out. */
  exiting: ReadonlyMap<string, LayoutRect>;
}

/**
 * Glides the whole layout to each new target over LAYOUT_MS, so collapsing or
 * expanding a subtree slides instead of teleporting. A target arriving
 * mid-flight is picked up from wherever the boxes currently are, never from a
 * stale start, so rapid toggling stays smooth.
 *
 * With `enabled` false (or reduced motion asked for) it is a pass-through and
 * costs nothing: same object in, same object out, no frames scheduled.
 */
export function useAnimatedLayout(target: MindmapLayout, enabled: boolean): AnimatedLayout {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const displayedRef = useRef(target);
  const fromRef = useRef(target);
  const startedAtRef = useRef(0);
  const rafRef = useRef(0);
  const exitingRef = useRef(new Map<string, LayoutRect>());
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const animate = enabled && !prefersReducedMotion();
  if (!animate) displayedRef.current = target; // keep the pass-through in sync for the next enable

  useEffect(() => {
    if (!animate) return;

    // Boxes that vanished stay on screen, where they were, until they've faded.
    for (const [id, rect] of displayedRef.current.rects) {
      if (!target.rects.has(id)) exitingRef.current.set(id, rect);
    }
    for (const id of target.rects.keys()) exitingRef.current.delete(id); // came back
    if (exitingRef.current.size > 0) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = setTimeout(() => {
        exitingRef.current = new Map();
        tick();
      }, EXIT_MS);
    }

    fromRef.current = displayedRef.current;
    startedAtRef.current = performance.now();
    cancelAnimationFrame(rafRef.current);

    const step = () => {
      const p = Math.min(1, (performance.now() - startedAtRef.current) / LAYOUT_MS);
      displayedRef.current = p >= 1 ? target : lerpLayout(fromRef.current, target, easeGlide(p));
      tick();
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    return () => cancelAnimationFrame(rafRef.current);
  }, [target, animate]);

  useEffect(() => () => clearTimeout(exitTimerRef.current), []);

  return animate
    ? { layout: displayedRef.current, exiting: exitingRef.current }
    : { layout: target, exiting: NO_EXITS };
}
