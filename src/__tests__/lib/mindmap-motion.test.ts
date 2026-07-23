import { describe, expect, it } from 'vitest';
import type { MindmapLayout } from '../../lib/mindmap-layout';
import { easeGlide, lerpLayout } from '../../lib/mindmap-motion';

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

describe('easeGlide', () => {
  it('is pinned at both ends', () => {
    expect(easeGlide(0)).toBe(0);
    expect(easeGlide(1)).toBe(1);
    expect(easeGlide(-1)).toBe(0);
    expect(easeGlide(2)).toBe(1);
  });

  it('is a smooth ease-in-out: slow start, symmetric midpoint, no overshoot', () => {
    expect(easeGlide(0.25)).toBeLessThan(0.25);    // eases in — a slow start, so motion isn't front-loaded
    expect(easeGlide(0.5)).toBeCloseTo(0.5, 5);     // symmetric
    expect(easeGlide(0.75)).toBeGreaterThan(0.75);  // eases out — a slow end
    const peak = Math.max(...Array.from({ length: 99 }, (_, i) => easeGlide((i + 1) / 100)));
    expect(peak).toBeLessThanOrEqual(1);            // never past the target (no overshoot)
  });

  it('is monotonic (never moves backward)', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = easeGlide(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
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
