import { buildTree } from '../../lib/mindmap-tree';
import { layoutMindmap, edgePath, H_GAP, V_GAP, type NodeSize } from '../../lib/mindmap-layout';
import type { MindmapNode } from '../../db/models';

function node(id: string, overrides: Partial<MindmapNode> = {}): MindmapNode {
  return { id, mapId: 'm1', label: id, order: 0, createdAt: 1, updatedAt: 1, ...overrides };
}

function sizesFor(ids: string[], size: NodeSize = { w: 100, h: 40 }): Map<string, NodeSize> {
  return new Map(ids.map((id) => [id, { ...size }]));
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Deterministic PRNG so failures reproduce.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('layoutMindmap', () => {
  it('lays out a single node at the origin', () => {
    const tree = buildTree([node('root')]);
    const layout = layoutMindmap(tree, sizesFor(['root']), new Set());
    expect(layout.rects.get('root')).toEqual({ x: 0, y: 0, w: 100, h: 40 });
    expect(layout.edges).toEqual([]);
  });

  it('places every child strictly right of its parent (L→R invariant)', () => {
    const tree = buildTree([
      node('root'),
      node('a', { parentId: 'root' }),
      node('b', { parentId: 'root', order: 1 }),
      node('a1', { parentId: 'a' }),
    ]);
    const layout = layoutMindmap(tree, sizesFor(['root', 'a', 'b', 'a1']), new Set());
    for (const e of layout.edges) {
      const parent = layout.rects.get(e.fromId)!;
      const child = layout.rects.get(e.toId)!;
      expect(child.x).toBe(parent.x + parent.w + H_GAP);
      expect(child.x).toBeGreaterThan(parent.x);
    }
  });

  it('stacks siblings with V_GAP and centers the parent on them', () => {
    const tree = buildTree([
      node('root'),
      node('a', { parentId: 'root' }),
      node('b', { parentId: 'root', order: 1 }),
    ]);
    const layout = layoutMindmap(tree, sizesFor(['root', 'a', 'b']), new Set());
    const a = layout.rects.get('a')!;
    const b = layout.rects.get('b')!;
    const root = layout.rects.get('root')!;
    expect(b.y).toBe(a.y + a.h + V_GAP);
    const childrenCenter = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
    expect(root.y + root.h / 2).toBeCloseTo(childrenCenter, 5);
  });

  it('centers children on a parent taller than their total', () => {
    const tree = buildTree([node('root'), node('a', { parentId: 'root' })]);
    const sizes = new Map<string, NodeSize>([
      ['root', { w: 100, h: 200 }],
      ['a', { w: 100, h: 40 }],
    ]);
    const layout = layoutMindmap(tree, sizes, new Set());
    const root = layout.rects.get('root')!;
    const a = layout.rects.get('a')!;
    expect(root.y).toBe(0);
    expect(a.y + a.h / 2).toBeCloseTo(root.y + root.h / 2, 5);
  });

  it('collapsed nodes hide their subtree from rects and edges', () => {
    const tree = buildTree([
      node('root'),
      node('a', { parentId: 'root' }),
      node('a1', { parentId: 'a' }),
      node('b', { parentId: 'root', order: 1 }),
    ]);
    const layout = layoutMindmap(tree, sizesFor(['root', 'a', 'a1', 'b']), new Set(['a']));
    expect(layout.rects.has('a')).toBe(true);
    expect(layout.rects.has('a1')).toBe(false);
    expect(layout.edges.some((e) => e.toId === 'a1')).toBe(false);
  });

  it('handles a deep chain without overlap', () => {
    const rows = [node('n0')];
    for (let i = 1; i < 30; i++) rows.push(node(`n${i}`, { parentId: `n${i - 1}` }));
    const tree = buildTree(rows);
    const layout = layoutMindmap(tree, sizesFor(rows.map((r) => r.id)), new Set());
    expect(layout.rects.size).toBe(30);
    expect(layout.rects.get('n29')!.x).toBe(29 * (100 + H_GAP));
  });

  it('property: random trees with variable node heights never overlap and keep L→R', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = mulberry32(seed);
      const rows = [node('n0')];
      const count = 5 + Math.floor(rand() * 40);
      for (let i = 1; i < count; i++) {
        const parent = `n${Math.floor(rand() * i)}`;
        rows.push(node(`n${i}`, { parentId: parent, order: Math.floor(rand() * 5) }));
      }
      const sizes = new Map<string, NodeSize>(
        rows.map((r) => [r.id, { w: 60 + Math.floor(rand() * 160), h: 24 + Math.floor(rand() * 120) }]),
      );
      const tree = buildTree(rows);
      const layout = layoutMindmap(tree, sizes, new Set());

      const entries = [...layout.rects.entries()];
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          if (overlaps(entries[i][1], entries[j][1])) {
            throw new Error(`seed ${seed}: ${entries[i][0]} overlaps ${entries[j][0]}`);
          }
        }
      }
      for (const e of layout.edges) {
        const parent = layout.rects.get(e.fromId)!;
        const child = layout.rects.get(e.toId)!;
        if (child.x <= parent.x) {
          throw new Error(`seed ${seed}: ${e.toId} not right of ${e.fromId}`);
        }
      }
    }
  });

  it('bounds cover all rects', () => {
    const tree = buildTree([node('root'), node('a', { parentId: 'root' })]);
    const layout = layoutMindmap(tree, sizesFor(['root', 'a']), new Set());
    for (const r of layout.rects.values()) {
      expect(r.x).toBeGreaterThanOrEqual(layout.bounds.minX);
      expect(r.y).toBeGreaterThanOrEqual(layout.bounds.minY);
      expect(r.x + r.w).toBeLessThanOrEqual(layout.bounds.maxX);
      expect(r.y + r.h).toBeLessThanOrEqual(layout.bounds.maxY);
    }
  });
});

describe('edgePath', () => {
  it('produces a cubic Bézier from parent edge to child edge', () => {
    const path = edgePath({ fromId: 'a', toId: 'b', x1: 100, y1: 20, x2: 148, y2: 60 });
    expect(path).toBe('M 100 20 C 124 20, 124 60, 148 60');
  });
});
