import { db, cleanMindmapOrphans } from '../../db';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createMindmapFolder, createMindmap, deleteMindmapFolder, restoreMindmapFolder } from '../../hooks/use-mindmaps';

// Reliability review 2026-10-06 (M8): device A moved folder F1 into F2 while
// device B moved F2 into F1. Every parent existed, so the orphan repair did
// nothing, and both folders — with every map in them — could no longer be
// reached from anywhere. And a map created in a folder another device deleted
// at the same time stayed live yet invisible, outside the Trash.

beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it('breaks a folder cycle by moving its smallest id to the top level', async () => {
  const a = assertDefined(await createMindmapFolder('A'));
  const b = assertDefined(await createMindmapFolder('B'));
  const map = assertDefined(await createMindmap('Plans', a.id));
  // The merged result of the two concurrent moves.
  await db.mindmapFolders.update(a.id, { parentId: b.id });
  await db.mindmapFolders.update(b.id, { parentId: a.id });

  await cleanMindmapOrphans();

  const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
  expect((await db.mindmapFolders.get(first.id))?.parentId).toBeUndefined();
  expect((await db.mindmapFolders.get(second.id))?.parentId).toBe(first.id);
  expect((await db.mindmaps.get(map.id))?.folderId).toBe(a.id);
  // The repair syncs, so every device ends up with the same tree.
  const entry = (await db.changeLog.toArray()).find((e) => e.entityId === first.id && e.operation === 'upsert' && !(e.data as { parentId?: string }).parentId);
  expect(entry).toBeDefined();
});

it('a map created in a folder deleted elsewhere joins that delete, and comes back with it', async () => {
  const folder = assertDefined(await createMindmapFolder('Old'));
  await deleteMindmapFolder(folder.id);
  const deletedAt = assertDefined((await db.mindmapFolders.get(folder.id))?.deletedAt);
  // Synced in from the other device: a live map (and its root node) in that folder.
  const map = assertDefined(await createMindmap('Made meanwhile', folder.id));
  const root = assertDefined(await db.mindmapNodes.where('mapId').equals(map.id).first());

  await cleanMindmapOrphans();

  expect((await db.mindmaps.get(map.id))?.deletedAt).toBe(deletedAt);
  expect((await db.mindmapNodes.get(root.id))?.deletedAt).toBe(deletedAt);

  await restoreMindmapFolder(folder.id);
  expect((await db.mindmaps.get(map.id))?.deletedAt).toBeUndefined();
  expect((await db.mindmapNodes.get(root.id))?.deletedAt).toBeUndefined();
});

it('a subfolder created in a deleted folder joins it too, with its maps', async () => {
  const folder = assertDefined(await createMindmapFolder('Old'));
  await deleteMindmapFolder(folder.id);
  const deletedAt = assertDefined((await db.mindmapFolders.get(folder.id))?.deletedAt);
  const sub = assertDefined(await createMindmapFolder('Sub', folder.id));
  const map = assertDefined(await createMindmap('Deep', sub.id));

  await cleanMindmapOrphans();

  expect((await db.mindmapFolders.get(sub.id))?.deletedAt).toBe(deletedAt);
  expect((await db.mindmaps.get(map.id))?.deletedAt).toBe(deletedAt);
});
