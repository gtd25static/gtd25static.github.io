import { db } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import {
  createMindmapFolder,
  renameMindmapFolder,
  moveMindmapFolder,
  deleteMindmapFolder,
  getFolderCascade,
  createMindmap,
  renameMindmap,
  moveMindmapToFolder,
  deleteMindmap,
  restoreMindmap,
  restoreMindmapFolder,
  createMindmapNode,
  updateMindmapNodeLabel,
  reparentMindmapNode,
  deleteMindmapNodeSubtree,
  createMindmapFromOutline,
  clampMindmapLabel,
} from '../../hooks/use-mindmaps';
import { restoreFromTrash, permanentlyDelete } from '../../hooks/use-trash';

beforeEach(async () => {
  await resetDb();
});

async function rootOf(mapId: string) {
  const nodes = await db.mindmapNodes.where('mapId').equals(mapId).toArray();
  return assertDefined(nodes.find((n) => !n.parentId), 'root node');
}

describe('clampMindmapLabel', () => {
  it('trims, rejects empty, caps at 1000 chars', () => {
    expect(clampMindmapLabel('  hi  ')).toBe('hi');
    expect(clampMindmapLabel('   ')).toBeNull();
    expect(clampMindmapLabel('x'.repeat(1500))).toHaveLength(1000);
  });
});

describe('createMindmap', () => {
  it('creates the map plus a root node labelled like the map, with fieldTimestamps', async () => {
    const map = assertDefined(await createMindmap('My plan'));
    expect(map.name).toBe('My plan');
    const root = await rootOf(map.id);
    expect(root.label).toBe('My plan');
    expect(root.parentId).toBeUndefined();
    expect(map.fieldTimestamps?.name).toBeGreaterThan(0);
    expect(root.fieldTimestamps?.label).toBeGreaterThan(0);
  });

  it('records changelog upserts for map and root', async () => {
    const map = assertDefined(await createMindmap('M'));
    const entries = await db.changeLog.toArray();
    expect(entries.some((e) => e.entityType === 'mindmap' && e.entityId === map.id)).toBe(true);
    expect(entries.some((e) => e.entityType === 'mindmapNode')).toBe(true);
  });

  it('creates inside a folder', async () => {
    const folder = assertDefined(await createMindmapFolder('F'));
    const map = assertDefined(await createMindmap('M', folder.id));
    expect(map.folderId).toBe(folder.id);
  });
});

describe('nodes', () => {
  it('createMindmapNode appends to the parent with incrementing order', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const a = assertDefined(await createMindmapNode(map.id, root.id, 'A'));
    const b = assertDefined(await createMindmapNode(map.id, root.id, 'B'));
    expect(a.parentId).toBe(root.id);
    expect(a.order).toBe(0);
    expect(b.order).toBe(1);
  });

  it('rejects creating under a missing or cross-map parent', async () => {
    const map = assertDefined(await createMindmap('M'));
    const other = assertDefined(await createMindmap('Other'));
    const otherRoot = await rootOf(other.id);
    expect(await createMindmapNode(map.id, 'nope', 'X')).toBeUndefined();
    expect(await createMindmapNode(map.id, otherRoot.id, 'X')).toBeUndefined();
  });

  it('updateMindmapNodeLabel stamps the label field and rejects empty labels', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    expect(await updateMindmapNodeLabel(root.id, '  New **bold** label ')).toBe(true);
    const updated = assertDefined(await db.mindmapNodes.get(root.id));
    expect(updated.label).toBe('New **bold** label');
    expect(updated.fieldTimestamps?.label).toBeGreaterThanOrEqual(root.fieldTimestamps!.label);
    expect(await updateMindmapNodeLabel(root.id, '   ')).toBe(false);
  });

  it('reparentMindmapNode moves a node and stamps parentId/order; rejects root/self/descendant/cross-map', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const a = assertDefined(await createMindmapNode(map.id, root.id, 'A'));
    const b = assertDefined(await createMindmapNode(map.id, root.id, 'B'));
    const a1 = assertDefined(await createMindmapNode(map.id, a.id, 'A1'));

    expect(await reparentMindmapNode(b.id, a.id)).toBe(true);
    const movedB = assertDefined(await db.mindmapNodes.get(b.id));
    expect(movedB.parentId).toBe(a.id);
    expect(movedB.fieldTimestamps?.parentId).toBeGreaterThan(0);

    expect(await reparentMindmapNode(root.id, a.id)).toBe(false);  // root immovable
    expect(await reparentMindmapNode(a.id, a.id)).toBe(false);     // self
    expect(await reparentMindmapNode(a.id, a1.id)).toBe(false);    // own descendant
    const other = assertDefined(await createMindmap('Other'));
    const otherRoot = await rootOf(other.id);
    expect(await reparentMindmapNode(a.id, otherRoot.id)).toBe(false); // cross-map
  });

  it('deleteMindmapNodeSubtree tombstones the node and all descendants, not the root', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const a = assertDefined(await createMindmapNode(map.id, root.id, 'A'));
    const a1 = assertDefined(await createMindmapNode(map.id, a.id, 'A1'));
    const b = assertDefined(await createMindmapNode(map.id, root.id, 'B'));

    await deleteMindmapNodeSubtree(a.id);
    expect((await db.mindmapNodes.get(a.id))?.deletedAt).toBeTruthy();
    expect((await db.mindmapNodes.get(a1.id))?.deletedAt).toBeTruthy();
    expect((await db.mindmapNodes.get(b.id))?.deletedAt).toBeFalsy();

    await deleteMindmapNodeSubtree(root.id); // no-op
    expect((await db.mindmapNodes.get(root.id))?.deletedAt).toBeFalsy();
  });
});

describe('folders', () => {
  it('rename and move between folders; cannot move into own subtree', async () => {
    const top = assertDefined(await createMindmapFolder('Top'));
    const sub = assertDefined(await createMindmapFolder('Sub', top.id));
    await renameMindmapFolder(sub.id, 'Renamed');
    expect((await db.mindmapFolders.get(sub.id))?.name).toBe('Renamed');

    expect(await moveMindmapFolder(top.id, sub.id)).toBe(false); // own subtree
    expect(await moveMindmapFolder(sub.id, undefined)).toBe(true);
    const moved = assertDefined(await db.mindmapFolders.get(sub.id));
    expect(moved.parentId).toBeUndefined();
  });

  it('deleteMindmapFolder cascades: subfolders, maps inside, and their nodes', async () => {
    const top = assertDefined(await createMindmapFolder('Top'));
    const sub = assertDefined(await createMindmapFolder('Sub', top.id));
    const map = assertDefined(await createMindmap('M', sub.id));
    const root = await rootOf(map.id);
    const outside = assertDefined(await createMindmap('Outside'));

    const cascade = await getFolderCascade(top.id);
    expect(cascade.folderIds.sort()).toEqual([top.id, sub.id].sort());
    expect(cascade.mapIds).toEqual([map.id]);
    expect(cascade.nodeCount).toBe(1);

    await deleteMindmapFolder(top.id);
    expect((await db.mindmapFolders.get(top.id))?.deletedAt).toBeTruthy();
    expect((await db.mindmapFolders.get(sub.id))?.deletedAt).toBeTruthy();
    expect((await db.mindmaps.get(map.id))?.deletedAt).toBeTruthy();
    expect((await db.mindmapNodes.get(root.id))?.deletedAt).toBeTruthy();
    expect((await db.mindmaps.get(outside.id))?.deletedAt).toBeFalsy();
  });
});

describe('map lifecycle', () => {
  it('rename, move to folder, delete cascades nodes, restore brings them back', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const child = assertDefined(await createMindmapNode(map.id, root.id, 'C'));

    await renameMindmap(map.id, 'M2');
    expect((await db.mindmaps.get(map.id))?.name).toBe('M2');

    const folder = assertDefined(await createMindmapFolder('F'));
    expect(await moveMindmapToFolder(map.id, folder.id)).toBe(true);
    expect((await db.mindmaps.get(map.id))?.folderId).toBe(folder.id);

    await deleteMindmap(map.id);
    expect((await db.mindmaps.get(map.id))?.deletedAt).toBeTruthy();
    expect((await db.mindmapNodes.get(child.id))?.deletedAt).toBeTruthy();

    await restoreMindmap(map.id);
    expect((await db.mindmaps.get(map.id))?.deletedAt).toBeFalsy();
    expect((await db.mindmapNodes.get(child.id))?.deletedAt).toBeFalsy();
    expect((await db.mindmapNodes.get(root.id))?.deletedAt).toBeFalsy();
  });

  it('restoreMindmapFolder restores the folder cascade', async () => {
    const folder = assertDefined(await createMindmapFolder('F'));
    const map = assertDefined(await createMindmap('M', folder.id));
    await deleteMindmapFolder(folder.id);
    await restoreMindmapFolder(folder.id);
    expect((await db.mindmapFolders.get(folder.id))?.deletedAt).toBeFalsy();
    expect((await db.mindmaps.get(map.id))?.deletedAt).toBeFalsy();
    expect((await rootOf(map.id)).deletedAt).toBeFalsy();
  });
});

describe('trash integration', () => {
  it('restoreFromTrash restores a deleted mindmap with nodes', async () => {
    const map = assertDefined(await createMindmap('M'));
    await deleteMindmap(map.id);
    await restoreFromTrash({ id: map.id, type: 'mindmap', title: 'M', deletedAt: Date.now() });
    expect((await db.mindmaps.get(map.id))?.deletedAt).toBeFalsy();
    expect((await rootOf(map.id)).deletedAt).toBeFalsy();
  });

  it('permanentlyDelete hard-deletes a mindmap and its nodes with delete entries', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    await deleteMindmap(map.id);
    await permanentlyDelete({ id: map.id, type: 'mindmap', title: 'M', deletedAt: Date.now() });
    expect(await db.mindmaps.get(map.id)).toBeUndefined();
    expect(await db.mindmapNodes.get(root.id)).toBeUndefined();
    const entries = await db.changeLog.toArray();
    expect(entries.some((e) => e.entityType === 'mindmap' && e.entityId === map.id && e.operation === 'delete')).toBe(true);
  });

  it('permanentlyDelete hard-deletes a folder cascade', async () => {
    const folder = assertDefined(await createMindmapFolder('F'));
    const map = assertDefined(await createMindmap('M', folder.id));
    await deleteMindmapFolder(folder.id);
    await permanentlyDelete({ id: folder.id, type: 'mindmapFolder', title: 'F', deletedAt: Date.now() });
    expect(await db.mindmapFolders.get(folder.id)).toBeUndefined();
    expect(await db.mindmaps.get(map.id)).toBeUndefined();
    expect(await db.mindmapNodes.where('mapId').equals(map.id).count()).toBe(0);
  });
});

describe('createMindmapFromOutline', () => {
  it('creates the whole tree root-first in one batch', async () => {
    const map = assertDefined(await createMindmapFromOutline('Imported', 'Root label', [
      { label: 'A', children: [{ label: 'A1', children: [] }] },
      { label: 'B', children: [] },
    ]));
    const nodes = await db.mindmapNodes.where('mapId').equals(map.id).toArray();
    expect(nodes).toHaveLength(4);
    const root = assertDefined(nodes.find((n) => !n.parentId));
    expect(root.label).toBe('Root label');
    const a = assertDefined(nodes.find((n) => n.label === 'A'));
    expect(a.parentId).toBe(root.id);
    const a1 = assertDefined(nodes.find((n) => n.label === 'A1'));
    expect(a1.parentId).toBe(a.id);
    // One changelog entry per row (map + 4 nodes), shared timestamp
    const entries = (await db.changeLog.toArray()).filter((e) => e.entityType.startsWith('mindmap'));
    expect(entries).toHaveLength(5);
    expect(new Set(entries.map((e) => e.timestamp)).size).toBe(1);
  });

  it('rejects an outline above the node cap', async () => {
    const wide = Array.from({ length: 2100 }, (_, i) => ({ label: `n${i}`, children: [] }));
    const map = await createMindmapFromOutline('Big', 'Root', wide);
    expect(map).toBeUndefined();
    expect(await db.mindmaps.count()).toBe(0);
  });
});
