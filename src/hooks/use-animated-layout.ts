import { useEffect, useReducer, useRef } from 'react';
import type { LayoutRect, MindmapLayout } from '../lib/mindmap-layout';
import {
  EXIT_MS,
  LAYOUT_MS,
  easeGlide,
  lerpLayout,
  motionDurationScale,
  prefersReducedMotion,
} from '../lib/mindmap-motion';

const NO_EXITS: ReadonlyMap<string, LayoutRect> = new Map();

export interface AnimatedLayout {
  /** What to draw this frame: the previous layout gliding towards `target`. */
  layout: MindmapLayout;
  /** Nodes that just left, held at their last box while they animate out. */
  exiting: ReadonlyMap<string, LayoutRect>;
  /**
   * This transition's duration scale (1 = full LAYOUT_MS; smaller = faster,
   * for big reveals). The canvas mirrors it into --mm-duration-scale so the
   * CSS enter fade keeps pace with the glide.
   */
  durationScale: number;
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

  const lastTargetRef = useRef(target);
  const scaleRef = useRef(1);

  const animate = enabled && !prefersReducedMotion();
  if (!animate) displayedRef.current = target; // keep the pass-through in sync for the next enable

  // One scale per transition, fixed against what was on screen when the target
  // arrived. It must NOT be recomputed per frame: entering nodes have boxes
  // from the first glide frame, which would snap the scale back to 1 and
  // retime the CSS fades mid-flight.
  if (lastTargetRef.current !== target) {
    lastTargetRef.current = target;
    let entering = 0;
    for (const id of target.rects.keys()) {
      if (!displayedRef.current.rects.has(id)) entering++;
    }
    scaleRef.current = motionDurationScale(entering, target.rects.size);
  }

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

    const durationMs = LAYOUT_MS * scaleRef.current;
    const step = () => {
      const p = Math.min(1, (performance.now() - startedAtRef.current) / durationMs);
      displayedRef.current = p >= 1 ? target : lerpLayout(fromRef.current, target, easeGlide(p));
      tick();
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    return () => cancelAnimationFrame(rafRef.current);
  }, [target, animate]);

  useEffect(() => () => clearTimeout(exitTimerRef.current), []);

  return animate
    ? { layout: displayedRef.current, exiting: exitingRef.current, durationScale: scaleRef.current }
    : { layout: target, exiting: NO_EXITS, durationScale: 1 };
}
