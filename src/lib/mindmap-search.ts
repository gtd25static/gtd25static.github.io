import type { Mindmap, MindmapFolder, MindmapNode } from '../db/models';
import { buildTree, type MindmapTree, type MindmapTreeNode } from './mindmap-tree';
import { isBlankFilter, matchesListFilter } from './list-filter';
import { mdToPlainText } from './mini-markdown';

// Search for the Mindmaps section: the browser's (folder and map names, and
// optionally the text of every node) and the one inside an open map. Both use
// the list filter's rules (lib/list-filter.ts — every word, accents and case
// aside, a typo only on whole long words), and a node matches on its OWN
// label: the browser lists a map for a node if and only if that node lights
// up when the map opens with the same search.

// Plain text per row object. Rows from a live query are stable between
// keystrokes, so each label is parsed once per row rather than once per key; a
// WeakMap lets the text go with the row (it holds nothing the row doesn't).
const plainTextCache = new WeakMap<MindmapNode, string>();

/** A node's label as the reader sees it: markdown marks and link targets dropped. */
export function nodeSearchText(node: MindmapNode): string {
  let text = plainTextCache.get(node);
  if (text === undefined) {
    // An unreadable row (`_decryptError`) may have no label at all.
    text = typeof node.label === 'string' ? mdToPlainText(node.label) : '';
    plainTextCache.set(node, text);
  }
  return text;
}

export function nodeMatchesSearch(query: string, node: MindmapNode): boolean {
  return !isBlankFilter(query) && matchesListFilter(query, [nodeSearchText(node)]);
}

/**
 * Ids of the nodes matching `query`, in reading order: depth-first, each
 * node before its children, siblings top to bottom — the order Enter steps
 * through them. Blank query → none.
 */
export function findNodeMatches(tree: MindmapTree, query: string): string[] {
  if (!tree.root || isBlankFilter(query)) return [];
  const ids: string[] = [];
  const walk = (n: MindmapTreeNode) => {
    if (matchesListFilter(query, [nodeSearchText(n.node)])) ids.push(n.node.id);
    for (const child of n.children) walk(child);
  };
  walk(tree.root);
  return ids;
}

/** Every ancestor of `ids` (`parentOf`: the tree as drawn, child → parent) — what must be open for them to show. */
export function ancestorsOf(ids: Iterable<string>, parentOf: Map<string, string>): Set<string> {
  const result = new Set<string>();
  for (const id of ids) {
    let cur = parentOf.get(id);
    while (cur && !result.has(cur)) {
      result.add(cur);
      cur = parentOf.get(cur);
    }
  }
  return result;
}

/** Names of the folders from the top level down to `folderId` (inclusive). */
export function folderPathNames(folderId: string | undefined, folderById: Map<string, MindmapFolder>): string[] {
  const path: string[] = [];
  let cur = folderId ? folderById.get(folderId) : undefined;
  while (cur && path.length < 32) { // a parent cycle from a bad merge must not hang the browser
    path.unshift(cur.name ?? '');
    cur = cur.parentId ? folderById.get(cur.parentId) : undefined;
  }
  return path;
}

export interface MapSearchHit {
  map: Mindmap;
  nameMatches: boolean;
  /** Matching nodes' text, in the map's reading order (as Enter steps through them); empty when node text isn't searched. */
  nodeTexts: string[];
}

export interface MindmapSearchResults {
  folders: MindmapFolder[];
  /** Maps whose name matches first, then those found only by a node; by name within each. */
  maps: MapSearchHit[];
}

const byName = (a: { name?: string }, b: { name?: string }) => (a.name ?? '').localeCompare(b.name ?? '');

/**
 * The browser's search, across every folder. `nodes` = every live node to
 * search in, or null to search names only. Nodes of maps not in `maps`
 * (deleted, or not loaded) are ignored.
 */
export function searchMindmaps(
  query: string,
  folders: MindmapFolder[],
  maps: Mindmap[],
  nodes: MindmapNode[] | null,
): MindmapSearchResults {
  if (isBlankFilter(query)) return { folders: [], maps: [] };

  const nodesByMap = new Map<string, MindmapNode[]>();
  const mapsWithHits = new Set<string>();
  for (const n of nodes ?? []) {
    if (n.deletedAt) continue;
    const list = nodesByMap.get(n.mapId) ?? [];
    list.push(n);
    nodesByMap.set(n.mapId, list);
    if (nodeMatchesSearch(query, n)) mapsWithHits.add(n.mapId);
  }

  const hits: MapSearchHit[] = [];
  for (const map of maps) {
    const nameMatches = matchesListFilter(query, [map.name]);
    // The tree is built only for maps with a hit, to list them in reading order.
    let nodeTexts: string[] = [];
    if (mapsWithHits.has(map.id)) {
      const tree = buildTree(nodesByMap.get(map.id)!);
      nodeTexts = findNodeMatches(tree, query).map((id) => nodeSearchText(tree.byId.get(id)!.node));
    }
    if (!nameMatches && nodeTexts.length === 0) continue;
    hits.push({ map, nameMatches, nodeTexts });
  }
  hits.sort((a, b) => Number(b.nameMatches) - Number(a.nameMatches) || byName(a.map, b.map));

  return {
    folders: folders.filter((f) => matchesListFilter(query, [f.name])).sort(byName),
    maps: hits,
  };
}
