import { describe, expect, it } from 'vitest';
import type { LayoutRect } from '../../lib/mindmap-layout';
import { V_GAP } from '../../lib/mindmap-layout';
import { dropLineY, resolveDropTarget } from '../../lib/mindmap-drop';

// Root on the left, two siblings stacked with the layout's real 12px gap.
const ROOT: LayoutRect = { x: 0, y: 24, w: 120, h: 36 };
const A: LayoutRect = { x: 168, y: 0, w: 120, h: 36 };
const B: LayoutRect = { x: 168, y: 48, w: 120, h: 36 };
const rects = new Map<string, LayoutRect>([['root', ROOT], ['a', A], ['b', B]]);
const resolve = (x: number, y: number, forbidden = new Set<string>()) =>
  resolveDropTarget({ x, y }, rects, forbidden, 'root');

describe('resolveDropTarget', () => {
  it('the middle of a node makes the dragged node its child', () => {
    expect(resolve(200, 18)).toEqual({ id: 'a', position: 'child' });
  });

  it('the top and bottom edges place it before / after the node, as a sibling', () => {
    expect(resolve(200, 2)).toEqual({ id: 'a', position: 'before' });
    expect(resolve(200, 34)).toEqual({ id: 'a', position: 'after' });
  });

  it('the gap between two siblings is a drop zone too, split down the middle', () => {
    expect(resolve(200, 36 + V_GAP / 2 - 1)).toEqual({ id: 'a', position: 'after' });
    expect(resolve(200, 36 + V_GAP / 2 + 1)).toEqual({ id: 'b', position: 'before' });
    // Just above the first sibling also counts.
    expect(resolve(200, -3)).toEqual({ id: 'a', position: 'before' });
  });

  it('the root only takes children — it has no siblings', () => {
    expect(resolve(60, 25)).toEqual({ id: 'root', position: 'child' });
    expect(resolve(60, 59)).toEqual({ id: 'root', position: 'child' });
    expect(resolve(60, 21)).toBeNull(); // no gap band around it either
  });

  it('skips forbidden nodes (the dragged node and its descendants)', () => {
    expect(resolve(200, 18, new Set(['a']))).toBeNull();
    // The gap half that belongs to a forbidden node is no target either.
    expect(resolve(200, 36 + V_GAP / 2 - 1, new Set(['a']))).toBeNull();
    expect(resolve(200, 60, new Set(['a']))).toEqual({ id: 'b', position: 'child' });
  });

  it('misses outside every node', () => {
    expect(resolve(140, 18)).toBeNull(); // the horizontal channel between columns
    expect(resolve(200, 200)).toBeNull();
  });
});

describe('dropLineY', () => {
  it('draws the insertion line in the middle of the gap above or below the node', () => {
    expect(dropLineY(A, 'before')).toBe(-V_GAP / 2);
    expect(dropLineY(A, 'after')).toBe(36 + V_GAP / 2);
    // Both halves of the same gap draw the same line.
    expect(dropLineY(A, 'after')).toBe(dropLineY(B, 'before'));
  });
});
