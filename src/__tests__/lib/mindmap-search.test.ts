import {
  ancestorsOf,
  findNodeMatches,
  folderPathNames,
  nodeMatchesSearch,
  nodeSearchText,
  searchMindmaps,
} from '../../lib/mindmap-search';
import { buildTree } from '../../lib/mindmap-tree';
import type { Mindmap, MindmapFolder, MindmapNode } from '../../db/models';

function node(id: string, overrides: Partial<MindmapNode> = {}): MindmapNode {
  return { id, mapId: 'm1', label: id, order: 0, createdAt: 1, updatedAt: 1, ...overrides };
}

function folder(id: string, name: string, parentId?: string): MindmapFolder {
  return { id, name, parentId, order: 0, createdAt: 1, updatedAt: 1 };
}

function map(id: string, name: string, folderId?: string): Mindmap {
  return { id, name, folderId, order: 0, createdAt: 1, updatedAt: 1 };
}

describe('nodeSearchText / nodeMatchesSearch', () => {
  it('searches what the reader sees: markdown marks and link targets are not text', () => {
    const n = node('a', { label: '**Budget** for [the trip](https://example.com/secret)' });
    expect(nodeSearchText(n)).toBe('Budget for the trip');
    expect(nodeMatchesSearch('budget trip', n)).toBe(true);
    expect(nodeMatchesSearch('secret', n)).toBe(false);
    expect(nodeMatchesSearch('**', n)).toBe(false);
  });

  it('follows the list filter rules: accents and case aside, every word, a typo on long words', () => {
    const n = node('a', { label: 'Presupuesto de Marketing' });
    expect(nodeMatchesSearch('PRESUPUÉSTO', n)).toBe(true);
    expect(nodeMatchesSearch('marketing presupuesto', n)).toBe(true);
    expect(nodeMatchesSearch('marketing ventas', n)).toBe(false);
    expect(nodeMatchesSearch('marketign', n)).toBe(true);
  });

  it('a blank query matches nothing', () => {
    expect(nodeMatchesSearch('  ', node('a'))).toBe(false);
  });

  it('a row without a readable label never throws and never matches', () => {
    const unreadable = { ...node('a'), label: undefined } as unknown as MindmapNode;
    expect(nodeSearchText(unreadable)).toBe('');
    expect(nodeMatchesSearch('a', unreadable)).toBe(false);
  });
});

describe('findNodeMatches', () => {
  const nodes = [
    node('root', { label: 'Plan' }),
    node('b', { parentId: 'root', label: 'Plan B', order: 1 }),
    node('a', { parentId: 'root', label: 'Alpha', order: 0 }),
    node('a1', { parentId: 'a', label: 'Plan A detail' }),
    node('b1', { parentId: 'b', label: 'Other' }),
  ];

  it('lists matches in reading order: parent before children, siblings top to bottom', () => {
    expect(findNodeMatches(buildTree(nodes), 'plan')).toEqual(['root', 'a1', 'b']);
  });

  it('blank query or empty map → no matches', () => {
    expect(findNodeMatches(buildTree(nodes), '')).toEqual([]);
    expect(findNodeMatches(buildTree([]), 'plan')).toEqual([]);
  });

  it('ignores deleted nodes', () => {
    const tree = buildTree([...nodes, node('gone', { parentId: 'root', label: 'Plan Z', deletedAt: 5 })]);
    expect(findNodeMatches(tree, 'plan z')).toEqual([]);
  });
});

describe('ancestorsOf', () => {
  it('collects every ancestor of every id, without the ids themselves', () => {
    const parentOf = new Map([['a', 'root'], ['a1', 'a'], ['a2', 'a'], ['b', 'root']]);
    expect(ancestorsOf(['a1', 'a2'], parentOf)).toEqual(new Set(['a', 'root']));
    expect(ancestorsOf(['root'], parentOf)).toEqual(new Set());
  });

  it('terminates on a cyclic map', () => {
    const parentOf = new Map([['a', 'b'], ['b', 'a']]);
    expect(ancestorsOf(['a'], parentOf)).toEqual(new Set(['a', 'b']));
  });
});

describe('folderPathNames', () => {
  it('names the path from the top level down', () => {
    const byId = new Map([folder('f1', 'Work'), folder('f2', 'Projects', 'f1')].map((f) => [f.id, f]));
    expect(folderPathNames('f2', byId)).toEqual(['Work', 'Projects']);
    expect(folderPathNames(undefined, byId)).toEqual([]);
  });

  it('stops on a parent cycle', () => {
    const byId = new Map([folder('f1', 'A', 'f2'), folder('f2', 'B', 'f1')].map((f) => [f.id, f]));
    expect(folderPathNames('f1', byId).length).toBe(32);
  });
});

describe('searchMindmaps', () => {
  const folders = [folder('f1', 'Ideas'), folder('f2', 'Old ideas', 'f1'), folder('f3', 'Work')];
  const maps = [map('m1', 'Holiday plan', 'f1'), map('m2', 'Budget'), map('m3', 'Roadmap', 'f3')];
  const nodes = [
    node('n0', { mapId: 'm2', label: 'Root' }),
    node('n1', { mapId: 'm2', parentId: 'n0', label: 'Holiday flights', order: 0, createdAt: 2 }),
    node('n2', { mapId: 'm2', parentId: 'n0', label: 'Holiday hotel', order: 1, createdAt: 1 }),
    node('n3', { mapId: 'm3', label: 'Q3' }),
    node('n4', { mapId: 'gone', label: 'Holiday' }),
    node('n5', { mapId: 'm3', label: 'Holiday deleted', deletedAt: 9 }),
  ];

  it('finds folders and maps by name, in every folder', () => {
    const r = searchMindmaps('ideas', folders, maps, null);
    expect(r.folders.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(searchMindmaps('roadmap', folders, maps, null).maps.map((h) => h.map.id)).toEqual(['m3']);
  });

  it('without node text, a node never makes a map match', () => {
    expect(searchMindmaps('holiday', folders, maps, null).maps.map((h) => h.map.id)).toEqual(['m1']);
  });

  it('with node text: name matches first, then maps found by a node, with the matching texts', () => {
    const r = searchMindmaps('holiday', folders, maps, nodes);
    expect(r.maps.map((h) => [h.map.id, h.nameMatches])).toEqual([['m1', true], ['m2', false]]);
    expect(r.maps[1].nodeTexts).toEqual(['Holiday flights', 'Holiday hotel']); // reading order, not age
  });

  it('nodes of deleted or unknown maps, and deleted nodes, are ignored', () => {
    const r = searchMindmaps('holiday', folders, maps, nodes);
    expect(r.maps.some((h) => h.map.id === 'm3')).toBe(false);
  });

  it('a blank query finds nothing', () => {
    expect(searchMindmaps(' ', folders, maps, nodes)).toEqual({ folders: [], maps: [] });
  });
});
