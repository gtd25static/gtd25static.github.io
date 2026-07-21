import { buildTree, descendantIds, isDescendant } from '../../lib/mindmap-tree';
import type { MindmapNode } from '../../db/models';

function node(id: string, overrides: Partial<MindmapNode> = {}): MindmapNode {
  return {
    id,
    mapId: 'm1',
    label: id,
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('buildTree', () => {
  it('returns null root for no nodes', () => {
    expect(buildTree([]).root).toBeNull();
  });

  it('builds a simple tree with siblings ordered by order, createdAt, id', () => {
    const tree = buildTree([
      node('root'),
      node('b', { parentId: 'root', order: 1 }),
      node('a', { parentId: 'root', order: 0 }),
      node('c2', { parentId: 'root', order: 2, createdAt: 2 }),
      node('c1', { parentId: 'root', order: 2, createdAt: 1 }),
    ]);
    expect(tree.root?.node.id).toBe('root');
    expect(tree.root?.children.map((c) => c.node.id)).toEqual(['a', 'b', 'c1', 'c2']);
  });

  it('ignores soft-deleted nodes', () => {
    const tree = buildTree([
      node('root'),
      node('dead', { parentId: 'root', deletedAt: 5 }),
      node('alive', { parentId: 'root' }),
    ]);
    expect(tree.root?.children.map((c) => c.node.id)).toEqual(['alive']);
    expect(tree.byId.has('dead')).toBe(false);
  });

  it('two-root anomaly: oldest becomes root, the other its child — deterministically', () => {
    const rows = [
      node('r2', { createdAt: 5 }),
      node('r1', { createdAt: 1 }),
      node('kid', { parentId: 'r2' }),
    ];
    const tree = buildTree(rows);
    expect(tree.root?.node.id).toBe('r1');
    expect(tree.root?.children.map((c) => c.node.id)).toEqual(['r2']);
    // Same result regardless of input order
    const tree2 = buildTree([...rows].reverse());
    expect(tree2.root?.node.id).toBe('r1');
    expect(tree2.root?.children.map((c) => c.node.id)).toEqual(['r2']);
  });

  it('orphan subtree (parent missing): its top attaches under root, structure kept', () => {
    const tree = buildTree([
      node('root'),
      node('orphan-top', { parentId: 'vanished' }),
      node('orphan-kid', { parentId: 'orphan-top' }),
    ]);
    expect(tree.root?.children.map((c) => c.node.id)).toEqual(['orphan-top']);
    const top = tree.byId.get('orphan-top')!;
    expect(top.children.map((c) => c.node.id)).toEqual(['orphan-kid']);
  });

  it('concurrent-reparent cycle: absorbed under root, all nodes present, deterministic', () => {
    const rows = [
      node('root'),
      node('x', { parentId: 'y' }),
      node('y', { parentId: 'x' }),
      node('c', { parentId: 'x' }),
    ];
    const tree = buildTree(rows);
    const allIds = new Set([...tree.byId.keys()]);
    expect(allIds).toEqual(new Set(['root', 'x', 'y', 'c']));
    // Every node reachable from root exactly once
    const seen: string[] = [];
    const walk = (n: NonNullable<typeof tree.root>) => {
      seen.push(n.node.id);
      n.children.forEach(walk);
    };
    walk(tree.root!);
    expect([...seen].sort()).toEqual(['c', 'root', 'x', 'y']);
    // Determinism across input orders
    const tree2 = buildTree([...rows].reverse());
    const seen2: string[] = [];
    const walk2 = (n: NonNullable<typeof tree2.root>) => {
      seen2.push(n.node.id);
      n.children.forEach(walk2);
    };
    walk2(tree2.root!);
    expect(seen2).toEqual(seen);
  });

  it('full cycle with no root: oldest node promoted', () => {
    const tree = buildTree([
      node('a', { parentId: 'b', createdAt: 2 }),
      node('b', { parentId: 'a', createdAt: 1 }),
    ]);
    expect(tree.root?.node.id).toBe('b');
    expect(tree.root?.children.map((c) => c.node.id)).toEqual(['a']);
  });
});

describe('descendantIds / isDescendant', () => {
  const tree = buildTree([
    node('root'),
    node('a', { parentId: 'root' }),
    node('a1', { parentId: 'a' }),
    node('a1x', { parentId: 'a1' }),
    node('b', { parentId: 'root', order: 1 }),
  ]);

  it('collects the whole subtree, excluding the node itself', () => {
    expect(descendantIds(tree, 'a')).toEqual(new Set(['a1', 'a1x']));
    expect(descendantIds(tree, 'b')).toEqual(new Set());
    expect(descendantIds(tree, 'missing')).toEqual(new Set());
  });

  it('isDescendant matches', () => {
    expect(isDescendant(tree, 'a', 'a1x')).toBe(true);
    expect(isDescendant(tree, 'a', 'b')).toBe(false);
    expect(isDescendant(tree, 'a1x', 'a')).toBe(false);
  });
});
