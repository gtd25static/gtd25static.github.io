import { describe, expect, it } from 'vitest';
import type { LayoutRect } from '../../lib/mindmap-layout';
import {
  ACTION_HIT_R,
  HOVER_PAD,
  anchorPoints,
  nodeActionAnchors,
  resolveHoverTarget,
} from '../../lib/mindmap-hover';

// Two siblings stacked with the layout's real 12px vertical gap; B is the wider
// one, so A's buttons end up floating over it.
const A: LayoutRect = { x: 100, y: 0, w: 120, h: 36 };
const B: LayoutRect = { x: 100, y: 48, w: 200, h: 36 };
const rects = new Map<string, LayoutRect>([['a', A], ['b', B]]);

const anchorsOf = (rect: LayoutRect, isRoot = false, hasToggle = false) =>
  anchorPoints(nodeActionAnchors(rect, { isRoot, hasToggle }));

const hovering = (id: string, rect: LayoutRect) => ({ id, anchors: anchorsOf(rect) });

describe('nodeActionAnchors', () => {
  it('places the child button clear of the toggle when the node has one', () => {
    expect(nodeActionAnchors(A, { isRoot: false, hasToggle: false }).addChild.x).toBe(236);
    expect(nodeActionAnchors(A, { isRoot: false, hasToggle: true }).addChild.x).toBe(256);
  });

  it('drops the sibling and delete anchors for the root', () => {
    const a = nodeActionAnchors(A, { isRoot: true, hasToggle: true });
    expect(a.addSibling).toBeNull();
    expect(a.remove).toBeNull();
    expect(anchorPoints(a)).toHaveLength(2);
  });
});

describe('resolveHoverTarget', () => {
  it('picks the node whose box contains the pointer', () => {
    expect(resolveHoverTarget({ x: 160, y: 18 }, rects, null)).toBe('a');
    expect(resolveHoverTarget({ x: 160, y: 60 }, rects, null)).toBe('b');
  });

  it('switches immediately when the pointer enters another node', () => {
    // Clear of A's buttons, well inside B
    expect(resolveHoverTarget({ x: 115, y: 78 }, rects, hovering('a', A))).toBe('b');
  });

  it('keeps the hovered node while the pointer is on its buttons, even over a neighbour', () => {
    const onAddSibling = nodeActionAnchors(A, { isRoot: false, hasToggle: false }).addSibling!;
    expect(onAddSibling).toEqual({ x: 234, y: 52 }); // inside B, which is drawn underneath
    expect(resolveHoverTarget(onAddSibling, rects, null)).toBe('b');
    expect(resolveHoverTarget(onAddSibling, rects, hovering('a', A))).toBe('a');
  });

  it('holds the hover in the gap around a node, then releases it', () => {
    const withoutButtons = { id: 'a', anchors: [] }; // isolate the grace band
    expect(resolveHoverTarget({ x: 160, y: A.y + A.h + 4 }, rects, withoutButtons)).toBe('a');
    expect(resolveHoverTarget({ x: A.x - HOVER_PAD + 1, y: 18 }, rects, withoutButtons)).toBe('a');
    expect(resolveHoverTarget({ x: A.x - HOVER_PAD - 1, y: 18 }, rects, withoutButtons)).toBeNull();
    expect(resolveHoverTarget({ x: 900, y: 900 }, rects, hovering('a', A))).toBeNull();
  });

  it('reports nothing when the pointer is on empty canvas', () => {
    expect(resolveHoverTarget({ x: 0, y: 300 }, rects, null)).toBeNull();
  });

  it('keeps hover out beyond the grace band while a button is under the pointer', () => {
    const editAnchor = nodeActionAnchors(A, { isRoot: false, hasToggle: false }).edit;
    // The edit button floats 16px above the box — further than HOVER_PAD alone reaches
    expect(editAnchor.y).toBeLessThan(A.y - HOVER_PAD);
    expect(resolveHoverTarget(editAnchor, rects, hovering('a', A))).toBe('a');
    const justOutside = { x: editAnchor.x, y: editAnchor.y - ACTION_HIT_R - 1 };
    expect(resolveHoverTarget(justOutside, rects, hovering('a', A))).toBeNull();
  });
});
