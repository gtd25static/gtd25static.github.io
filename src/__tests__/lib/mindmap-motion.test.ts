import { describe, expect, it } from 'vitest';
import type { MindmapLayout } from '../../lib/mindmap-layout';
import { easeOutBackTiny, lerpLayout } from '../../lib/mindmap-motion';

function layout(boxes: Record<string, [number, number]>, edges: Array<[string, string]> = []): MindmapLayout {
  const rects = new Map(Object.entries(boxes).map(([id, [x, y]]) => [id, { x, y, w: 100, h: 30 }]));
  return {
    rects,
    edges: edges.map(([fromId, toId]) => {
      const p = rects.get(fromId)!;
      const c = rects.get(toId)!;
      return { fromId, toId, x1: p.x + p.w, y1: p.y + p.h / 2, x2: c.x, y2: c.y + c.h / 2 };
    }),
    bounds: { minX: 0, minY: 0, maxX: 400, maxY: 400 },
  };
}

describe('easeOutBackTiny', () => {
  it('is pinned at both ends', () => {
    expect(easeOutBackTiny(0)).toBe(0);
    expect(easeOutBackTiny(1)).toBe(1);
    expect(easeOutBackTiny(-1)).toBe(0);
    expect(easeOutBackTiny(2)).toBe(1);
  });

  it('overshoots, but only just — a hint of bounce, not a bounce', () => {
    const peak = Math.max(...Array.from({ length: 99 }, (_, i) => easeOutBackTiny((i + 1) / 100)));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.06);
  });

  it('runs ahead of linear (it eases out)', () => {
    expect(easeOutBackTiny(0.5)).toBeGreaterThan(0.5);
  });
});

describe('lerpLayout', () => {
  const from = layout({ root: [0, 0], a: [200, 0], b: [200, 60] }, [['root', 'a'], ['root', 'b']]);
  const to = layout({ root: [0, 0], a: [200, 30], b: [200, 90] }, [['root', 'a'], ['root', 'b']]);

  it('returns the target untouched at t = 1', () => {
    expect(lerpLayout(from, to, 1)).toBe(to);
  });

  it('places boxes halfway at t = 0.5', () => {
    const mid = lerpLayout(from, to, 0.5);
    expect(mid.rects.get('a')).toEqual({ x: 200, y: 15, w: 100, h: 30 });
    expect(mid.bounds).toEqual(from.bounds); // identical bounds interpolate to themselves
  });

  it('carries the overshoot past the target instead of clamping it', () => {
    const over = lerpLayout(from, to, 1.02);
    expect(over.rects.get('a')!.y).toBeGreaterThan(to.rects.get('a')!.y);
  });

  it('keeps every edge attached to the boxes it connects', () => {
    const mid = lerpLayout(from, to, 0.37);
    for (const e of mid.edges) {
      const parent = mid.rects.get(e.fromId)!;
      const child = mid.rects.get(e.toId)!;
      expect(e.x1).toBe(parent.x + parent.w);
      expect(e.y1).toBe(parent.y + parent.h / 2);
      expect(e.x2).toBe(child.x);
      expect(e.y2).toBe(child.y + child.h / 2);
    }
  });

  it('unfolds a newly-revealed node out of its on-screen parent', () => {
    const grown = layout({ root: [0, 0], a: [200, 0], b: [200, 60], c: [400, 30] }, [['a', 'c']]);
    const mid = lerpLayout(from, grown, 0.5);
    // 'c' has no previous box, but its parent 'a' (at 200,0) was on screen, so it
    // starts there and glides halfway to its target (400,30) — a subtree
    // unfolding from its parent, not popping in at the final place.
    const c = mid.rects.get('c')!;
    expect(c.x).toBeCloseTo(300, 5); // (200 + 400) / 2
    expect(c.y).toBeCloseTo(15, 5);  // (0 + 30) / 2
    // …and its brand-new edge still hangs off the interpolated parent
    expect(mid.edges[0].x1).toBe(mid.rects.get('a')!.x + 100);
  });

  it('still starts a node in place when no ancestor was on screen to unfold from', () => {
    const before = layout({});
    const after = layout({ root: [0, 0], a: [200, 40] }, [['root', 'a']]);
    // Neither 'a' nor its parent existed before → nothing to grow out of.
    expect(lerpLayout(before, after, 0.5).rects.get('a')).toEqual({ x: 200, y: 40, w: 100, h: 30 });
  });
});
