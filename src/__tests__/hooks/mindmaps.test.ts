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
  restoreMindmapNodeSubtree,
  updateMindmapNodeStyle,
  setMindmapSmartColoring,
  createMindmapFromOutline,
  exportMindmapOutline,
  clampMindmapLabel,
} from '../../hooks/use-mindmaps';
import { restoreFromTrash, permanentlyDelete } from '../../hooks/use-trash';
import { useMindmapUi } from '../../stores/mindmap-ui';
import { tick, loggedIds } from '../helpers/cascade-fixtures';

beforeEach(async () => {
  await resetDb();
  // Smart colouring is sticky across maps and lives in a module-level store —
  // reset it so map creation doesn't depend on what an earlier test toggled.
  useMindmapUi.getState().setSmartColoringDefault(false);
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

    const deleted = await deleteMindmapNodeSubtree(a.id);
    expect(new Set(deleted)).toEqual(new Set([a.id, a1.id]));
    expect((await db.mindmapNodes.get(a.id))?.deletedAt).toBeTruthy();
    expect((await db.mindmapNodes.get(a1.id))?.deletedAt).toBeTruthy();
    expect((await db.mindmapNodes.get(b.id))?.deletedAt).toBeFalsy();

    expect(await deleteMindmapNodeSubtree(root.id)).toEqual([]); // no-op
    expect((await db.mindmapNodes.get(root.id))?.deletedAt).toBeFalsy();
  });

  it('updateMindmapNodeStyle stores shape/preset/colours and stamps only what changed', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const a = assertDefined(await createMindmapNode(map.id, root.id, 'A'));

    expect(await updateMindmapNodeStyle(a.id, { shape: 'diamond', palette: 'mint' })).toBe(true);
    let stored = assertDefined(await db.mindmapNodes.get(a.id));
    expect(stored.shape).toBe('diamond');
    expect(stored.palette).toBe('mint');
    expect(stored.fieldTimestamps?.shape).toBeGreaterThan(0);
    expect(stored.fieldTimestamps?.palette).toBeGreaterThan(0);
    expect(stored.fieldTimestamps?.label).toBeLessThanOrEqual(stored.fieldTimestamps!.shape!);

    // null clears a part, and the key is removed rather than left undefined
    expect(await updateMindmapNodeStyle(a.id, { palette: null, colorBg: '#0a0b0c' })).toBe(true);
    stored = assertDefined(await db.mindmapNodes.get(a.id));
    expect('palette' in stored).toBe(false);
    expect(stored.colorBg).toBe('#0a0b0c');
    expect(stored.shape).toBe('diamond'); // untouched parts survive
  });

  it('updateMindmapNodeStyle drops anything that is not a known shape/preset or #rrggbb', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const a = assertDefined(await createMindmapNode(map.id, root.id, 'A'));
    await updateMindmapNodeStyle(a.id, { palette: 'sky', colorBg: '#ffffff' });

    await updateMindmapNodeStyle(a.id, {
      shape: 'triangle' as never,
      palette: 'sky); background: url(evil',
      colorBg: 'red; position: fixed',
      colorFg: '#abc',
    });
    const stored = assertDefined(await db.mindmapNodes.get(a.id));
    expect(stored.shape).toBeUndefined();
    expect('palette' in stored).toBe(false); // the junk cleared it, never stored it
    expect('colorBg' in stored).toBe(false);
    expect('colorFg' in stored).toBe(false);
  });

  it('restoreMindmapNodeSubtree brings back exactly the ids it is given', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const a = assertDefined(await createMindmapNode(map.id, root.id, 'A'));
    const a1 = assertDefined(await createMindmapNode(map.id, a.id, 'A1'));
    const b = assertDefined(await createMindmapNode(map.id, root.id, 'B'));

    // b was already in the bin before a's subtree went — undo must not revive it
    await deleteMindmapNodeSubtree(b.id);
    const deleted = await deleteMindmapNodeSubtree(a.id);

    await restoreMindmapNodeSubtree(deleted);
    expect((await db.mindmapNodes.get(a.id))?.deletedAt).toBeFalsy();
    expect((await db.mindmapNodes.get(a1.id))?.deletedAt).toBeFalsy();
    expect((await db.mindmapNodes.get(b.id))?.deletedAt).toBeTruthy();
    expect((await db.mindmapNodes.get(a.id))?.fieldTimestamps?.deletedAt).toBeGreaterThan(0);

    // Sync learns about the restore as an upsert carrying the live row
    const log = (await db.changeLog.toArray()).filter((c) => c.entityId === a.id);
    const upsert = log.find((c) => c.operation === 'upsert');
    expect(upsert).toBeDefined();
    expect((upsert?.data as { deletedAt?: number } | undefined)?.deletedAt).toBeUndefined();
  });

  it('restore is a no-op for an empty list or once the whole map is in the trash', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const a = assertDefined(await createMindmapNode(map.id, root.id, 'A'));
    const deleted = await deleteMindmapNodeSubtree(a.id);

    await restoreMindmapNodeSubtree([]);
    await deleteMindmap(map.id);
    await restoreMindmapNodeSubtree(deleted);
    expect((await db.mindmapNodes.get(a.id))?.deletedAt).toBeTruthy();
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

/**
 * Top > Sub > Inner (root, live node `kept`, node `goneNode` deleted earlier).
 * Top also holds a live map `sibling`, a map `goneMap` deleted earlier and a
 * folder `goneFolder` deleted earlier (with map `goneFolderMap` inside).
 */
async function seedMindmapTree() {
  const top = assertDefined(await createMindmapFolder('Top'));
  const sub = assertDefined(await createMindmapFolder('Sub', top.id));
  const inner = assertDefined(await createMindmap('Inner', sub.id));
  const innerRoot = await rootOf(inner.id);
  const kept = assertDefined(await createMindmapNode(inner.id, innerRoot.id, 'Kept'));
  const goneNode = assertDefined(await createMindmapNode(inner.id, innerRoot.id, 'Gone node'));
  const sibling = assertDefined(await createMindmap('Sibling', top.id));
  const goneMap = assertDefined(await createMindmap('Gone map', top.id));
  const goneFolder = assertDefined(await createMindmapFolder('Gone folder', top.id));
  const goneFolderMap = assertDefined(await createMindmap('In gone folder', goneFolder.id));
  await deleteMindmapNodeSubtree(goneNode.id);
  await deleteMindmap(goneMap.id);
  await deleteMindmapFolder(goneFolder.id);
  const earlier = {
    goneNode: assertDefined((await db.mindmapNodes.get(goneNode.id))?.deletedAt),
    goneMap: assertDefined((await db.mindmaps.get(goneMap.id))?.deletedAt),
    goneFolder: assertDefined((await db.mindmapFolders.get(goneFolder.id))?.deletedAt),
    goneFolderMap: assertDefined((await db.mindmaps.get(goneFolderMap.id))?.deletedAt),
  };
  await tick();
  return { top, sub, inner, innerRoot, kept, goneNode, sibling, goneMap, goneFolder, goneFolderMap, earlier };
}

async function expectEarlierDeletesKept(s: Awaited<ReturnType<typeof seedMindmapTree>>) {
  expect((await db.mindmapNodes.get(s.goneNode.id))?.deletedAt).toBe(s.earlier.goneNode);
  expect((await db.mindmaps.get(s.goneMap.id))?.deletedAt).toBe(s.earlier.goneMap);
  expect((await db.mindmapFolders.get(s.goneFolder.id))?.deletedAt).toBe(s.earlier.goneFolder);
  expect((await db.mindmaps.get(s.goneFolderMap.id))?.deletedAt).toBe(s.earlier.goneFolderMap);
  expect((await rootOf(s.goneFolderMap.id)).deletedAt).toBe(s.earlier.goneFolderMap);
}

describe('mindmap delete / restore vs. rows deleted earlier', () => {
  it('a node subtree delete stamps every node with one deletedAt', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const a = assertDefined(await createMindmapNode(map.id, root.id, 'A'));
    const a1 = assertDefined(await createMindmapNode(map.id, a.id, 'A1'));
    const a11 = assertDefined(await createMindmapNode(map.id, a1.id, 'A11'));
    await deleteMindmapNodeSubtree(a.id);
    const at = assertDefined((await db.mindmapNodes.get(a.id))?.deletedAt);
    expect((await db.mindmapNodes.get(a1.id))?.deletedAt).toBe(at);
    expect((await db.mindmapNodes.get(a11.id))?.deletedAt).toBe(at);
  });

  it('deleteMindmapFolder keeps the deletedAt of rows deleted before and logs no delete for them', async () => {
    const s = await seedMindmapTree();
    await db.changeLog.clear();

    await deleteMindmapFolder(s.top.id);

    await expectEarlierDeletesKept(s);
    expect(await loggedIds('delete')).toEqual(
      [s.top.id, s.sub.id, s.inner.id, s.innerRoot.id, s.kept.id, s.sibling.id, (await rootOf(s.sibling.id)).id].sort(),
    );
  });

  it('restoreMindmap brings back only the nodes the map delete took', async () => {
    const s = await seedMindmapTree();
    await deleteMindmap(s.inner.id);
    await db.changeLog.clear();

    await restoreMindmap(s.inner.id);

    expect((await db.mindmaps.get(s.inner.id))?.deletedAt).toBeUndefined();
    expect((await db.mindmapNodes.get(s.innerRoot.id))?.deletedAt).toBeUndefined();
    expect((await db.mindmapNodes.get(s.kept.id))?.deletedAt).toBeUndefined();
    expect((await db.mindmapNodes.get(s.goneNode.id))?.deletedAt).toBe(s.earlier.goneNode);
    expect(await loggedIds('upsert')).toEqual([s.inner.id, s.innerRoot.id, s.kept.id].sort());
  });

  it('restoreMindmapFolder brings back only the folders, maps and nodes the folder delete took', async () => {
    const s = await seedMindmapTree();
    await deleteMindmapFolder(s.top.id);
    await db.changeLog.clear();

    await restoreFromTrash({ id: s.top.id, type: 'mindmapFolder', title: 'Top', deletedAt: Date.now() });

    for (const f of [s.top, s.sub]) expect((await db.mindmapFolders.get(f.id))?.deletedAt).toBeUndefined();
    for (const m of [s.inner, s.sibling]) expect((await db.mindmaps.get(m.id))?.deletedAt).toBeUndefined();
    expect((await db.mindmapNodes.get(s.kept.id))?.deletedAt).toBeUndefined();
    await expectEarlierDeletesKept(s);
    const siblingRoot = await rootOf(s.sibling.id);
    expect(await loggedIds('upsert')).toEqual(
      [s.top.id, s.sub.id, s.inner.id, s.innerRoot.id, s.kept.id, s.sibling.id, siblingRoot.id].sort(),
    );
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

  it('exportMindmapOutline emits the live tree as markdown (deleted maps → null)', async () => {
    const map = assertDefined(await createMindmapFromOutline('Trip', 'Trip plan', [
      { label: 'Pack', children: [{ label: 'Boots', children: [] }] },
    ]));
    const exported = assertDefined(await exportMindmapOutline(map.id) ?? undefined, 'export');
    expect(exported.filename).toBe('Trip.md');
    expect(exported.content).toBe('# Trip plan\n\n- Pack\n  - Boots\n');

    await deleteMindmap(map.id);
    expect(await exportMindmapOutline(map.id)).toBeNull();
  });

  it('rejects an outline above the node cap', async () => {
    const wide = Array.from({ length: 2100 }, (_, i) => ({ label: `n${i}`, children: [] }));
    const map = await createMindmapFromOutline('Big', 'Root', wide);
    expect(map).toBeUndefined();
    expect(await db.mindmaps.count()).toBe(0);
  });
});

describe('smart colouring', () => {
  it('createMindmapNode bakes a branch style, stamping its fields', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const node = assertDefined(await createMindmapNode(map.id, root.id, undefined, { palette: 'sky' }));
    expect(node.palette).toBe('sky');
    expect(node.fieldTimestamps?.palette).toBeGreaterThan(0);
  });

  it('createMindmapNode keeps valid colours and drops invalid ones', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const node = assertDefined(await createMindmapNode(map.id, root.id, undefined, {
      palette: 'not-a-preset',
      colorBg: '#112233',
      colorFg: 'red',
      colorBorder: '#445566',
    }));
    expect(node.palette).toBeUndefined();      // unknown preset dropped
    expect(node.colorBg).toBe('#112233');      // valid hex kept
    expect(node.colorFg).toBeUndefined();      // non-hex dropped
    expect(node.colorBorder).toBe('#445566');
  });

  it('setMindmapSmartColoring turns the mode on (stamped) and off (field removed)', async () => {
    const map = assertDefined(await createMindmap('M'));
    expect(await setMindmapSmartColoring(map.id, true)).toBe(true);
    const on = assertDefined(await db.mindmaps.get(map.id));
    expect(on.smartColoring).toBe(true);
    expect(on.fieldTimestamps?.smartColoring).toBeGreaterThan(0);

    expect(await setMindmapSmartColoring(map.id, false)).toBe(true);
    const off = assertDefined(await db.mindmaps.get(map.id));
    expect('smartColoring' in off).toBe(false); // off = no key, row stays clean
  });

  it('stores a pasted URL as a link with a short label', async () => {
    const map = assertDefined(await createMindmap('M'));
    const root = await rootOf(map.id);
    const node = assertDefined(
      await createMindmapNode(map.id, root.id, 'read https://www.example.com/blog/2026/how-sleep-works'),
    );
    expect(node.label).toBe('read [example.com/how-sleep-works](https://www.example.com/blog/2026/how-sleep-works)');

    await updateMindmapNodeLabel(node.id, 'https://example.com/a/b/c');
    const updated = assertDefined(await db.mindmapNodes.get(node.id));
    expect(updated.label).toBe('[example.com/c](https://example.com/a/b/c)');
  });

  it('linkifies URLs in an imported outline too', async () => {
    const map = assertDefined(
      await createMindmapFromOutline('Imported', 'Root', [{ label: 'src https://example.com/x/y', children: [] }]),
    );
    const nodes = await db.mindmapNodes.where('mapId').equals(map.id).toArray();
    const child = assertDefined(nodes.find((n) => n.parentId));
    expect(child.label).toBe('src [example.com/y](https://example.com/x/y)');
  });

  it('smart colouring sticks to the NEXT map created, never to existing ones', async () => {
    const before = assertDefined(await createMindmap('Before'));
    expect(before.smartColoring).toBeUndefined();

    await setMindmapSmartColoring(before.id, true);
    const after = assertDefined(await createMindmap('After'));
    expect(after.smartColoring).toBe(true);
    expect(after.fieldTimestamps?.smartColoring).toBeGreaterThan(0); // stamped like any field
    expect((await db.mindmaps.get(after.id))?.smartColoring).toBe(true);

    // A map that already existed when the toggle flipped keeps whatever it had.
    const untouched = assertDefined(await createMindmap('Untouched'));
    await setMindmapSmartColoring(after.id, false);
    expect((await db.mindmaps.get(untouched.id))?.smartColoring).toBe(true);
  });

  it('the sticky default reaches imported maps, and off is sticky too', async () => {
    const seed = assertDefined(await createMindmap('Seed'));
    await setMindmapSmartColoring(seed.id, true);
    const imported = assertDefined(
      await createMindmapFromOutline('Imported', 'Root', [{ label: 'a', children: [] }]),
    );
    expect(imported.smartColoring).toBe(true);

    await setMindmapSmartColoring(seed.id, false);
    const plain = assertDefined(await createMindmap('Plain'));
    expect('smartColoring' in plain).toBe(false);
    const plainImport = assertDefined(await createMindmapFromOutline('I2', 'Root', []));
    expect('smartColoring' in plainImport).toBe(false);
  });
});
