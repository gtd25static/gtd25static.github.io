import { db, cleanMindmapOrphans } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { makeChangeEntry, makeMindmapFolder, makeMindmap, makeMindmapNode } from '../helpers/sync-helpers';
import { applyRemoteEntries } from '../../sync/change-log';
import { getLocalSnapshot } from '../../sync/sync-engine';
import { cleanupSoftDeletes } from '../../sync/conflict-resolution';
import { deriveKey, generateSalt, encryptSyncData, decryptSyncData, encryptChangeEntries } from '../../sync/crypto';
import { SYNC_VERSION, isCompatibleVersion } from '../../sync/version';
import { runRemoteMigrations } from '../../sync/migrations';
import { runLocalMigrations } from '../../sync/local-migrations';
import type { MindmapNode, SyncData } from '../../db/models';

beforeEach(async () => {
  await resetDb();
});

describe('mindmap sync (applyRemoteEntries)', () => {
  it('applies remote folder/map/node upserts, including a root node with no parentId', async () => {
    const folder = makeMindmapFolder({ id: 'f1', name: 'Ideas' });
    const map = makeMindmap({ id: 'm1', name: 'Plan', folderId: 'f1' });
    const root = makeMindmapNode({ id: 'n-root', mapId: 'm1', label: 'Plan' }); // no parentId
    const child = makeMindmapNode({ id: 'n-child', mapId: 'm1', parentId: 'n-root', label: 'Step 1' });

    await applyRemoteEntries([
      makeChangeEntry({ entityType: 'mindmapFolder', entityId: 'f1', data: folder as unknown as Record<string, unknown> }),
      makeChangeEntry({ entityType: 'mindmap', entityId: 'm1', data: map as unknown as Record<string, unknown> }),
      makeChangeEntry({ entityType: 'mindmapNode', entityId: 'n-root', data: root as unknown as Record<string, unknown> }),
      makeChangeEntry({ entityType: 'mindmapNode', entityId: 'n-child', data: child as unknown as Record<string, unknown> }),
    ]);

    expect((await db.mindmapFolders.get('f1'))?.name).toBe('Ideas');
    expect((await db.mindmaps.get('m1'))?.folderId).toBe('f1');
    const storedRoot = await db.mindmapNodes.get('n-root');
    expect(storedRoot).toBeDefined();
    expect(storedRoot?.parentId).toBeUndefined();
    expect((await db.mindmapNodes.get('n-child'))?.parentId).toBe('n-root');
  });

  it('rejects a node entry missing required fields (no label)', async () => {
    await applyRemoteEntries([
      makeChangeEntry({
        entityType: 'mindmapNode',
        entityId: 'bad',
        data: { id: 'bad', mapId: 'm1', order: 0, createdAt: 1, updatedAt: 1 },
      }),
    ]);
    expect(await db.mindmapNodes.get('bad')).toBeUndefined();
  });

  it('tolerates a child arriving before its parent (dangling parentId is written)', async () => {
    const child = makeMindmapNode({ id: 'n2', mapId: 'm1', parentId: 'n-not-yet-here' });
    await applyRemoteEntries([
      makeChangeEntry({ entityType: 'mindmapNode', entityId: 'n2', data: child as unknown as Record<string, unknown> }),
    ]);
    expect((await db.mindmapNodes.get('n2'))?.parentId).toBe('n-not-yet-here');
  });

  it('applies a remote delete as a soft-delete', async () => {
    await db.mindmapNodes.add(makeMindmapNode({ id: 'n3', updatedAt: 1000 }));
    await applyRemoteEntries([
      makeChangeEntry({ entityType: 'mindmapNode', entityId: 'n3', operation: 'delete', timestamp: 2000, data: undefined }),
    ]);
    expect((await db.mindmapNodes.get('n3'))?.deletedAt).toBe(2000);
  });

  it('merges per-field: local label edit survives a remote reparent of the same node', async () => {
    await db.mindmapNodes.add(makeMindmapNode({
      id: 'nx', mapId: 'm1', parentId: 'p1', label: 'Edited locally',
      updatedAt: 3000,
      fieldTimestamps: { mapId: 1000, parentId: 1000, order: 1000, label: 3000 },
    }));
    const remote = makeMindmapNode({
      id: 'nx', mapId: 'm1', parentId: 'p2', label: 'Old label',
      createdAt: 1000, updatedAt: 2000,
      fieldTimestamps: { mapId: 1000, parentId: 2000, order: 1000, label: 1000 },
    });
    await applyRemoteEntries([
      makeChangeEntry({ entityType: 'mindmapNode', entityId: 'nx', timestamp: 2000, data: remote as unknown as Record<string, unknown> }),
    ]);
    const merged = await db.mindmapNodes.get('nx');
    expect(merged?.parentId).toBe('p2');          // remote reparent wins (newer)
    expect(merged?.label).toBe('Edited locally'); // local label wins (newer)
  });

  it('concurrent reparent of the same node converges to the newer write (LWW)', async () => {
    await db.mindmapNodes.add(makeMindmapNode({
      id: 'ny', mapId: 'm1', parentId: 'pa', updatedAt: 2000,
      fieldTimestamps: { mapId: 1000, parentId: 2000, order: 1000, label: 1000 },
    }));
    const remote = makeMindmapNode({
      id: 'ny', mapId: 'm1', parentId: 'pb', createdAt: 1000, updatedAt: 1500,
      fieldTimestamps: { mapId: 1000, parentId: 1500, order: 1000, label: 1000 },
    });
    await applyRemoteEntries([
      makeChangeEntry({ entityType: 'mindmapNode', entityId: 'ny', timestamp: 1500, data: remote as unknown as Record<string, unknown> }),
    ]);
    expect((await db.mindmapNodes.get('ny'))?.parentId).toBe('pa'); // local is newer, keeps
  });

  it('a remote reparent-to-root (parentId absent, newer stamp) clears the local parentId', async () => {
    await db.mindmapNodes.add(makeMindmapNode({
      id: 'nz', mapId: 'm1', parentId: 'pa', updatedAt: 1000,
      fieldTimestamps: { mapId: 1000, parentId: 1000, order: 1000, label: 1000 },
    }));
    const remote: Record<string, unknown> = {
      id: 'nz', mapId: 'm1', label: 'Node', order: 0, createdAt: 500, updatedAt: 2000,
      fieldTimestamps: { mapId: 1000, parentId: 2000, order: 1000, label: 1000 },
    };
    await applyRemoteEntries([
      makeChangeEntry({ entityType: 'mindmapNode', entityId: 'nz', timestamp: 2000, data: remote }),
    ]);
    expect((await db.mindmapNodes.get('nz'))?.parentId).toBeUndefined();
  });
});

describe('mindmaps in snapshot + soft-delete cleanup', () => {
  it('includes mindmap collections in the local snapshot', async () => {
    await db.mindmapFolders.add(makeMindmapFolder({ id: 'f1' }));
    await db.mindmaps.add(makeMindmap({ id: 'm1' }));
    await db.mindmapNodes.add(makeMindmapNode({ id: 'n1', mapId: 'm1' }));
    const snap = await getLocalSnapshot();
    expect(snap.mindmapFolders?.some((f) => f.id === 'f1')).toBe(true);
    expect(snap.mindmaps?.some((m) => m.id === 'm1')).toBe(true);
    expect(snap.mindmapNodes?.some((n) => n.id === 'n1')).toBe(true);
  });

  it('cleanupSoftDeletes drops mindmap tombstones older than 30 days', () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const fresh = Date.now() - 1000;
    const data = {
      syncVersion: SYNC_VERSION,
      taskLists: [], tasks: [], subtasks: [],
      mindmapFolders: [makeMindmapFolder({ id: 'f-old', deletedAt: old }), makeMindmapFolder({ id: 'f-live' })],
      mindmaps: [makeMindmap({ id: 'm-old', deletedAt: old })],
      mindmapNodes: [makeMindmapNode({ id: 'n-old', deletedAt: old }), makeMindmapNode({ id: 'n-fresh', deletedAt: fresh })],
      settings: { theme: 'system' as const },
    };
    const cleaned = cleanupSoftDeletes(data as unknown as SyncData);
    expect(cleaned.mindmapFolders?.map((f) => f.id)).toEqual(['f-live']);
    expect(cleaned.mindmaps).toEqual([]);
    expect(cleaned.mindmapNodes?.map((n) => n.id)).toEqual(['n-fresh']);
  });
});

describe('mindmap encryption', () => {
  it('encryptSyncData hides names/labels behind _enc and round-trips', async () => {
    const key = await deriveKey('pw', generateSalt());
    const data = {
      syncVersion: SYNC_VERSION,
      taskLists: [], tasks: [], subtasks: [],
      mindmapFolders: [makeMindmapFolder({ id: 'f1', name: 'Secret folder' })],
      mindmaps: [makeMindmap({ id: 'm1', name: 'Secret map' })],
      mindmapNodes: [makeMindmapNode({ id: 'n1', mapId: 'm1', label: 'Secret label' })],
      settings: { theme: 'system' as const },
    } as unknown as SyncData;

    const encrypted = await encryptSyncData(key, data);
    const wire = JSON.stringify(encrypted);
    expect(wire).not.toContain('Secret folder');
    expect(wire).not.toContain('Secret map');
    expect(wire).not.toContain('Secret label');
    // Structural fields stay plaintext for merge
    expect((encrypted.mindmapNodes?.[0] as unknown as Record<string, unknown>)._enc).toBeTruthy();
    expect(encrypted.mindmapNodes?.[0].mapId).toBe('m1');

    const decrypted = await decryptSyncData(key, encrypted);
    expect(decrypted.mindmapFolders?.[0].name).toBe('Secret folder');
    expect(decrypted.mindmaps?.[0].name).toBe('Secret map');
    expect(decrypted.mindmapNodes?.[0].label).toBe('Secret label');
  });

  it('encryptChangeEntries hides node labels in changelog entries', async () => {
    const key = await deriveKey('pw', generateSalt());
    const node = makeMindmapNode({ id: 'n1', label: 'Changelog secret' });
    const entries = await encryptChangeEntries(key, [
      makeChangeEntry({ entityType: 'mindmapNode', entityId: 'n1', data: node as unknown as Record<string, unknown> }),
    ]);
    expect(JSON.stringify(entries)).not.toContain('Changelog secret');
    expect(entries[0].data?._enc).toBeTruthy();
  });
});

describe('version gate + migrations (v6)', () => {
  it('SYNC_VERSION is 6 and a v6 remote is incompatible with an older gate value', () => {
    expect(SYNC_VERSION).toBe(6);
    // Current client accepts v6 and older; a hypothetical v7 remote is blocked.
    expect(isCompatibleVersion(6)).toBe(true);
    expect(isCompatibleVersion(5)).toBe(true);
    expect(isCompatibleVersion(7)).toBe(false);
  });

  it('remote migration 5→6 is additive (no data change beyond the stamp)', () => {
    const data = {
      syncVersion: 5,
      taskLists: [], tasks: [], subtasks: [],
      settings: { theme: 'system' as const },
    } as unknown as SyncData;
    const migrated = runRemoteMigrations(data, 5, 6);
    expect(migrated.syncVersion).toBe(6);
    expect(migrated.mindmaps).toBeUndefined(); // absent = no mindmaps, handled everywhere
  });

  it('local migration registry covers 5→6 (does not throw)', async () => {
    await expect(runLocalMigrations(db, 5, 6)).resolves.toBeUndefined();
  });
});

describe('cleanMindmapOrphans', () => {
  it('soft-deletes nodes whose map is hard-missing', async () => {
    await db.mindmapNodes.add(makeMindmapNode({ id: 'n1', mapId: 'gone' }));
    await cleanMindmapOrphans();
    expect((await db.mindmapNodes.get('n1'))?.deletedAt).toBeTruthy();
  });

  it('re-points nodes with a hard-missing parent to the root', async () => {
    await db.mindmaps.add(makeMindmap({ id: 'm1' }));
    await db.mindmapNodes.bulkAdd([
      makeMindmapNode({ id: 'root', mapId: 'm1', createdAt: 1 }),
      makeMindmapNode({ id: 'stray', mapId: 'm1', parentId: 'vanished', createdAt: 2 }),
    ]);
    await cleanMindmapOrphans();
    expect((await db.mindmapNodes.get('stray'))?.parentId).toBe('root');
  });

  it('breaks a reparent cycle deterministically and keeps all nodes reachable', async () => {
    await db.mindmaps.add(makeMindmap({ id: 'm1' }));
    // root, plus X→Y→X cycle with child C under X
    await db.mindmapNodes.bulkAdd([
      makeMindmapNode({ id: 'root', mapId: 'm1', createdAt: 1 }),
      makeMindmapNode({ id: 'x', mapId: 'm1', parentId: 'y', createdAt: 2 }),
      makeMindmapNode({ id: 'y', mapId: 'm1', parentId: 'x', createdAt: 3 }),
      makeMindmapNode({ id: 'c', mapId: 'm1', parentId: 'x', createdAt: 4 }),
    ]);
    await cleanMindmapOrphans();

    const nodes = await db.mindmapNodes.toArray();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // Everything reachable from root now
    const reachable = new Set(['root']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of nodes) {
        if (!reachable.has(n.id) && n.parentId && reachable.has(n.parentId)) {
          reachable.add(n.id);
          grew = true;
        }
      }
    }
    expect(reachable.size).toBe(4);
    // C kept its position under X (cycle broken at a cycle member, not at C)
    expect(byId.get('c')?.parentId).toBe('x');
  });

  it('re-points the top of an orphaned subtree (parent soft-deleted) to the root, keeping descendants', async () => {
    await db.mindmaps.add(makeMindmap({ id: 'm1' }));
    await db.mindmapNodes.bulkAdd([
      makeMindmapNode({ id: 'root', mapId: 'm1', createdAt: 1 }),
      makeMindmapNode({ id: 'dead', mapId: 'm1', parentId: 'root', createdAt: 2, deletedAt: 100 }),
      makeMindmapNode({ id: 'orphan-top', mapId: 'm1', parentId: 'dead', createdAt: 3 }),
      makeMindmapNode({ id: 'orphan-kid', mapId: 'm1', parentId: 'orphan-top', createdAt: 4 }),
    ]);
    await cleanMindmapOrphans();
    expect((await db.mindmapNodes.get('orphan-top'))?.parentId).toBe('root');
    expect((await db.mindmapNodes.get('orphan-kid'))?.parentId).toBe('orphan-top');
  });

  it('moves folders/maps with a hard-missing parent folder to the top level', async () => {
    await db.mindmapFolders.add(makeMindmapFolder({ id: 'f1', parentId: 'gone' }));
    await db.mindmaps.add(makeMindmap({ id: 'm1', folderId: 'gone' }));
    await cleanMindmapOrphans();
    expect((await db.mindmapFolders.get('f1'))?.parentId).toBeUndefined();
    expect((await db.mindmaps.get('m1'))?.folderId).toBeUndefined();
  });

  it('records changelog entries for its repairs (they must sync)', async () => {
    await db.mindmapNodes.add(makeMindmapNode({ id: 'n1', mapId: 'gone' }));
    const before = await db.changeLog.count();
    await cleanMindmapOrphans();
    const entries = await db.changeLog.toArray();
    expect(entries.length).toBeGreaterThan(before);
    expect(entries.some((e) => e.entityType === 'mindmapNode' && e.entityId === 'n1')).toBe(true);
  });

  it('promotes the oldest node to root when a map has none', async () => {
    await db.mindmaps.add(makeMindmap({ id: 'm1' }));
    await db.mindmapNodes.bulkAdd([
      makeMindmapNode({ id: 'a', mapId: 'm1', parentId: 'b', createdAt: 2 }),
      makeMindmapNode({ id: 'b', mapId: 'm1', parentId: 'a', createdAt: 1 }),
    ]);
    await cleanMindmapOrphans();
    const a = await db.mindmapNodes.get('a');
    const b = await db.mindmapNodes.get('b');
    expect(b?.parentId).toBeUndefined(); // oldest becomes root
    expect(a?.parentId).toBe('b');
  });
});

describe('mindmap node type shape', () => {
  it('root node round-trips through Dexie without a parentId key', async () => {
    const root: MindmapNode = makeMindmapNode({ id: 'r1', mapId: 'm1' });
    await db.mindmapNodes.add(root);
    const stored = await db.mindmapNodes.get('r1');
    expect(stored && 'parentId' in stored && stored.parentId !== undefined).toBe(false);
  });
});
