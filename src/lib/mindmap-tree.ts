import type { MindmapNode } from '../db/models';

// Builds the render tree for a mindmap from its flat node rows, absorbing every
// merge anomaly deterministically so all devices draw the same tree:
//   - root = the live node with no parentId (oldest createdAt, then smallest id);
//     extra no-parent nodes (two-root merges) become children of the root
//   - orphans (parent soft-deleted/missing) and reparent cycles are attached
//     under the root, ordered by id
// Persistence-side repair of the same anomalies lives in cleanMindmapOrphans
// (src/db/index.ts); this builder makes the view correct even before it runs.

export interface MindmapTreeNode {
  node: MindmapNode;
  children: MindmapTreeNode[];
}

export interface MindmapTree {
  root: MindmapTreeNode | null;
  byId: Map<string, MindmapTreeNode>;
}

function sortSiblings(a: MindmapNode, b: MindmapNode): number {
  return a.order - b.order || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
}

export function buildTree(nodes: MindmapNode[]): MindmapTree {
  const live = nodes.filter((n) => !n.deletedAt);
  if (live.length === 0) return { root: null, byId: new Map() };

  const byId = new Map<string, MindmapTreeNode>();
  for (const n of live) byId.set(n.id, { node: n, children: [] });

  const childrenOf = new Map<string, MindmapNode[]>();
  for (const n of live) {
    if (!n.parentId) continue;
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }

  const rootCandidates = live.filter((n) => !n.parentId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  // No no-parent node at all (unrepaired full cycle): promote the oldest node.
  const rootRow = rootCandidates[0] ?? [...live].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0];
  const root = byId.get(rootRow.id)!;

  const attached = new Set<string>([rootRow.id]);
  const attachSubtree = (treeNode: MindmapTreeNode) => {
    const kids = (childrenOf.get(treeNode.node.id) ?? []).sort(sortSiblings);
    for (const kid of kids) {
      if (attached.has(kid.id)) continue; // cycle guard
      attached.add(kid.id);
      const child = byId.get(kid.id)!;
      treeNode.children.push(child);
      attachSubtree(child);
    }
  };
  attachSubtree(root);

  // Extra roots (two-root merge anomaly): children of the real root.
  for (const extra of rootCandidates.slice(1)) {
    if (attached.has(extra.id)) continue;
    attached.add(extra.id);
    const child = byId.get(extra.id)!;
    root.children.push(child);
    attachSubtree(child);
  }

  // Orphans and cycles: attach the top of each stranded subtree under the root.
  // Preference mirrors cleanMindmapOrphans so display and persisted repair agree:
  // orphan-subtree tops (parent not live) first, then true cycle members
  // (walking the parent chain returns to the node), then whatever remains — by id.
  const isCycleMember = (start: string): boolean => {
    const seen = new Set<string>();
    let cur = byId.get(start)?.node.parentId;
    while (cur) {
      if (cur === start) return true;
      if (seen.has(cur)) return false;
      seen.add(cur);
      cur = byId.get(cur)?.node.parentId;
    }
    return false;
  };
  for (let guard = 0; guard < live.length && attached.size < live.length; guard++) {
    const stranded = live.filter((n) => !attached.has(n.id));
    const tops = stranded.filter((n) => n.parentId && !byId.has(n.parentId));
    const cycleMembers = tops.length > 0 ? [] : stranded.filter((n) => isCycleMember(n.id));
    const candidates = tops.length > 0 ? tops : (cycleMembers.length > 0 ? cycleMembers : stranded);
    const pick = candidates.sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    attached.add(pick.id);
    const child = byId.get(pick.id)!;
    root.children.push(child);
    attachSubtree(child);
  }

  return { root, byId };
}

/** Ids of every node in the subtree rooted at `id` (the node itself excluded). */
export function descendantIds(tree: MindmapTree, id: string): Set<string> {
  const result = new Set<string>();
  const start = tree.byId.get(id);
  if (!start) return result;
  const queue = [...start.children];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    result.add(cur.node.id);
    queue.push(...cur.children);
  }
  return result;
}

export function isDescendant(tree: MindmapTree, ancestorId: string, maybeDescendantId: string): boolean {
  return descendantIds(tree, ancestorId).has(maybeDescendantId);
}
