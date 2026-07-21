import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { ChangeEntry, Mindmap, MindmapFolder, MindmapNode } from '../db/models';
import { newId } from '../lib/id';
import { ensureDeviceId, recordChangeBatchInTx } from '../sync/change-log';
import { scheduleSyncDebounced, syncNow } from '../sync/sync-engine';
import { handleDbError } from '../lib/db-error';
import { initFieldTimestamps, stampUpdatedFields } from '../sync/field-timestamps';
import { encryptRow, getActiveAtRestKey } from '../db/vault-middleware';
import { SYNC_VERSION } from '../sync/version';
import { MAX_MINDMAP_LABEL_LENGTH, MAX_MINDMAP_IMPORT_NODES } from '../lib/constants';

// --- Queries ---

export function useMindmapFolders(): MindmapFolder[] {
  return useLiveQuery(
    async () => {
      const all = await db.mindmapFolders.orderBy('order').toArray();
      return all.filter((f) => !f.deletedAt);
    },
    [],
    [],
  );
}

export function useMindmaps(): Mindmap[] {
  return useLiveQuery(
    async () => {
      const all = await db.mindmaps.orderBy('order').toArray();
      return all.filter((m) => !m.deletedAt);
    },
    [],
    [],
  );
}

export function useMindmap(id: string | null): Mindmap | undefined {
  return useLiveQuery(
    () => (id ? db.mindmaps.get(id) : undefined),
    [id],
  );
}

export function useMindmapNodes(mapId: string | null): MindmapNode[] {
  return useLiveQuery(
    async () => {
      if (!mapId) return [];
      const all = await db.mindmapNodes.where('mapId').equals(mapId).toArray();
      return all.filter((n) => !n.deletedAt);
    },
    [mapId],
    [],
  );
}

// Live node counts per map, for the browser's "N nodes" badges.
export function useMindmapNodeCounts(): Map<string, number> {
  return useLiveQuery(
    async () => {
      const all = await db.mindmapNodes.toArray();
      const counts = new Map<string, number>();
      for (const n of all) {
        if (!n.deletedAt) counts.set(n.mapId, (counts.get(n.mapId) ?? 0) + 1);
      }
      return counts;
    },
    [],
    new Map<string, number>(),
  );
}

// --- Internal write helper ---

type MindmapWrite =
  | { table: 'mindmapFolders'; entityType: 'mindmapFolder'; row: MindmapFolder }
  | { table: 'mindmaps'; entityType: 'mindmap'; row: Mindmap }
  | { table: 'mindmapNodes'; entityType: 'mindmapNode'; row: MindmapNode };

// Upsert rows + matching changelog entries. Mirrors the Safari-safe pre-encrypt
// dance from use-shared-items: encrypt outside IndexedDB, then one short
// transaction the Paranoid middleware fast-passes synchronously.
async function putMindmapRows(writes: MindmapWrite[]): Promise<void> {
  if (writes.length === 0) return;
  const deviceId = await ensureDeviceId();
  const now = Date.now();

  const changes: ChangeEntry[] = writes.map((w) => ({
    id: newId(),
    deviceId,
    timestamp: now,
    entityType: w.entityType,
    entityId: w.row.id,
    operation: 'upsert',
    data: w.row as unknown as Record<string, unknown>,
    v: SYNC_VERSION,
  }));

  let rowsByTable: Record<MindmapWrite['table'], Record<string, unknown>[]> = {
    mindmapFolders: [], mindmaps: [], mindmapNodes: [],
  };
  let changeRows = changes as unknown as Record<string, unknown>[];
  const atRestKey = getActiveAtRestKey();
  if (atRestKey) {
    const encRows = await Promise.all(
      writes.map((w) => encryptRow(w.table, atRestKey, w.row as unknown as Record<string, unknown>)),
    );
    const encChanges = await Promise.all(
      changes.map((c) => encryptRow('changeLog', atRestKey, c as unknown as Record<string, unknown>)),
    );
    if (encRows.some((r) => !r) || encChanges.some((c) => !c)) {
      throw new Error('Failed to encrypt mindmap rows');
    }
    const grouped: typeof rowsByTable = { mindmapFolders: [], mindmaps: [], mindmapNodes: [] };
    encRows.forEach((r, i) => grouped[writes[i].table].push(r!));
    rowsByTable = grouped;
    changeRows = encChanges as Record<string, unknown>[];
  } else {
    writes.forEach((w) => rowsByTable[w.table].push(w.row as unknown as Record<string, unknown>));
  }

  await db.transaction('rw', [db.mindmapFolders, db.mindmaps, db.mindmapNodes, db.changeLog], async () => {
    if (rowsByTable.mindmapFolders.length > 0) await db.mindmapFolders.bulkPut(rowsByTable.mindmapFolders as unknown as MindmapFolder[]);
    if (rowsByTable.mindmaps.length > 0) await db.mindmaps.bulkPut(rowsByTable.mindmaps as unknown as Mindmap[]);
    if (rowsByTable.mindmapNodes.length > 0) await db.mindmapNodes.bulkPut(rowsByTable.mindmapNodes as unknown as MindmapNode[]);
    await db.changeLog.bulkAdd(changeRows as unknown as ChangeEntry[]);
  });
  scheduleSyncDebounced();
}

export function clampMindmapLabel(label: string): string | null {
  const trimmed = label.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_MINDMAP_LABEL_LENGTH);
}

async function nextFolderOrder(parentId: string | undefined): Promise<number> {
  const siblings = (await db.mindmapFolders.toArray()).filter((f) => !f.deletedAt && f.parentId === parentId);
  return siblings.reduce((max, f) => Math.max(max, f.order + 1), 0);
}

async function nextMapOrder(folderId: string | undefined): Promise<number> {
  const siblings = (await db.mindmaps.toArray()).filter((m) => !m.deletedAt && m.folderId === folderId);
  return siblings.reduce((max, m) => Math.max(max, m.order + 1), 0);
}

async function nextNodeOrder(mapId: string, parentId: string): Promise<number> {
  const siblings = (await db.mindmapNodes.where('mapId').equals(mapId).toArray())
    .filter((n) => !n.deletedAt && n.parentId === parentId);
  return siblings.reduce((max, n) => Math.max(max, n.order + 1), 0);
}

// Descendant folder ids of a folder (walks parentId links). Live rows only by
// default; includeDeleted=true also walks tombstoned rows (restore/purge paths).
async function descendantFolderIds(folderId: string, includeDeleted = false): Promise<Set<string>> {
  const all = (await db.mindmapFolders.toArray()).filter((f) => includeDeleted || !f.deletedAt);
  const childrenOf = new Map<string, string[]>();
  for (const f of all) {
    if (!f.parentId) continue;
    const list = childrenOf.get(f.parentId) ?? [];
    list.push(f.id);
    childrenOf.set(f.parentId, list);
  }
  const result = new Set<string>();
  const queue = [folderId];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const child of childrenOf.get(cur) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

// Live descendant node ids of a node within its map (the node itself excluded).
export async function descendantNodeIds(nodeId: string, mapId: string): Promise<Set<string>> {
  const all = (await db.mindmapNodes.where('mapId').equals(mapId).toArray()).filter((n) => !n.deletedAt);
  const childrenOf = new Map<string, string[]>();
  for (const n of all) {
    if (!n.parentId) continue;
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n.id);
    childrenOf.set(n.parentId, list);
  }
  const result = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const child of childrenOf.get(cur) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

// --- Folders ---

export async function createMindmapFolder(name: string, parentId?: string): Promise<MindmapFolder | undefined> {
  try {
    const clean = clampMindmapLabel(name);
    if (!clean) return undefined;
    const now = Date.now();
    const folder: MindmapFolder = {
      id: newId(),
      name: clean,
      ...(parentId ? { parentId } : {}),
      order: await nextFolderOrder(parentId),
      createdAt: now,
      updatedAt: now,
    };
    folder.fieldTimestamps = initFieldTimestamps(folder as unknown as Record<string, unknown>, now);
    await putMindmapRows([{ table: 'mindmapFolders', entityType: 'mindmapFolder', row: folder }]);
    return folder;
  } catch (error) {
    handleDbError(error, 'create mindmap folder');
    return undefined;
  }
}

export async function renameMindmapFolder(id: string, name: string): Promise<void> {
  try {
    const clean = clampMindmapLabel(name);
    if (!clean) return;
    const existing = await db.mindmapFolders.get(id);
    if (!existing) return;
    const now = Date.now();
    const updated: MindmapFolder = {
      ...existing,
      name: clean,
      updatedAt: now,
      fieldTimestamps: stampUpdatedFields(existing.fieldTimestamps, ['name'], now),
    };
    await putMindmapRows([{ table: 'mindmapFolders', entityType: 'mindmapFolder', row: updated }]);
  } catch (error) {
    handleDbError(error, 'rename mindmap folder');
  }
}

/** Move a folder to a new parent (undefined = top level). Rejects moving into its own subtree. */
export async function moveMindmapFolder(id: string, newParentId: string | undefined): Promise<boolean> {
  try {
    const existing = await db.mindmapFolders.get(id);
    if (!existing) return false;
    if (newParentId === id) return false;
    if (newParentId) {
      const target = await db.mindmapFolders.get(newParentId);
      if (!target || target.deletedAt) return false;
      const descendants = await descendantFolderIds(id);
      if (descendants.has(newParentId)) return false;
    }
    const now = Date.now();
    const updated: MindmapFolder = {
      ...existing,
      order: await nextFolderOrder(newParentId),
      updatedAt: now,
      fieldTimestamps: stampUpdatedFields(existing.fieldTimestamps, ['parentId', 'order'], now),
    };
    if (newParentId) updated.parentId = newParentId;
    else delete updated.parentId;
    await putMindmapRows([{ table: 'mindmapFolders', entityType: 'mindmapFolder', row: updated }]);
    return true;
  } catch (error) {
    handleDbError(error, 'move mindmap folder');
    return false;
  }
}

export interface FolderCascade {
  folderIds: string[];
  mapIds: string[];
  nodeCount: number;
}

/** What a folder delete would tombstone (for the confirm dialog). */
export async function getFolderCascade(folderId: string): Promise<FolderCascade> {
  const folderIds = [folderId, ...(await descendantFolderIds(folderId))];
  const folderSet = new Set(folderIds);
  const maps = (await db.mindmaps.toArray()).filter((m) => !m.deletedAt && m.folderId && folderSet.has(m.folderId));
  const mapIds = maps.map((m) => m.id);
  const mapSet = new Set(mapIds);
  const nodes = (await db.mindmapNodes.toArray()).filter((n) => !n.deletedAt && mapSet.has(n.mapId));
  return { folderIds, mapIds, nodeCount: nodes.length };
}

/** Soft-delete a folder, its descendant folders, their maps and those maps' nodes. */
export async function deleteMindmapFolder(id: string): Promise<void> {
  try {
    const cascade = await getFolderCascade(id);
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.mindmapFolders, db.mindmaps, db.mindmapNodes, db.changeLog], async () => {
      const batch: Array<{ entityType: 'mindmapFolder' | 'mindmap' | 'mindmapNode'; entityId: string; operation: 'delete' }> = [];
      for (const folderId of cascade.folderIds) {
        const f = await db.mindmapFolders.get(folderId);
        if (!f || f.deletedAt) continue;
        const ft = stampUpdatedFields(f.fieldTimestamps, ['deletedAt'], now);
        await db.mindmapFolders.update(folderId, { deletedAt: now, updatedAt: now, fieldTimestamps: ft });
        batch.push({ entityType: 'mindmapFolder', entityId: folderId, operation: 'delete' });
      }
      for (const mapId of cascade.mapIds) {
        const m = await db.mindmaps.get(mapId);
        if (!m || m.deletedAt) continue;
        const ft = stampUpdatedFields(m.fieldTimestamps, ['deletedAt'], now);
        await db.mindmaps.update(mapId, { deletedAt: now, updatedAt: now, fieldTimestamps: ft });
        batch.push({ entityType: 'mindmap', entityId: mapId, operation: 'delete' });
        const nodes = await db.mindmapNodes.where('mapId').equals(mapId).toArray();
        for (const n of nodes) {
          if (n.deletedAt) continue;
          const nft = stampUpdatedFields(n.fieldTimestamps, ['deletedAt'], now);
          await db.mindmapNodes.update(n.id, { deletedAt: now, updatedAt: now, fieldTimestamps: nft });
          batch.push({ entityType: 'mindmapNode', entityId: n.id, operation: 'delete' });
        }
      }
      await recordChangeBatchInTx(batch);
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'delete mindmap folder');
  }
}

// --- Maps ---

/** Create a map plus its root node (root label = map name) in one transaction. */
export async function createMindmap(name: string, folderId?: string): Promise<Mindmap | undefined> {
  try {
    const clean = clampMindmapLabel(name);
    if (!clean) return undefined;
    const now = Date.now();
    const map: Mindmap = {
      id: newId(),
      name: clean,
      ...(folderId ? { folderId } : {}),
      order: await nextMapOrder(folderId),
      createdAt: now,
      updatedAt: now,
    };
    map.fieldTimestamps = initFieldTimestamps(map as unknown as Record<string, unknown>, now);
    const root: MindmapNode = {
      id: newId(),
      mapId: map.id,
      label: clean,
      order: 0,
      createdAt: now,
      updatedAt: now,
    };
    root.fieldTimestamps = initFieldTimestamps(root as unknown as Record<string, unknown>, now);
    await putMindmapRows([
      { table: 'mindmaps', entityType: 'mindmap', row: map },
      { table: 'mindmapNodes', entityType: 'mindmapNode', row: root },
    ]);
    return map;
  } catch (error) {
    handleDbError(error, 'create mindmap');
    return undefined;
  }
}

export async function renameMindmap(id: string, name: string): Promise<void> {
  try {
    const clean = clampMindmapLabel(name);
    if (!clean) return;
    const existing = await db.mindmaps.get(id);
    if (!existing) return;
    const now = Date.now();
    const updated: Mindmap = {
      ...existing,
      name: clean,
      updatedAt: now,
      fieldTimestamps: stampUpdatedFields(existing.fieldTimestamps, ['name'], now),
    };
    await putMindmapRows([{ table: 'mindmaps', entityType: 'mindmap', row: updated }]);
  } catch (error) {
    handleDbError(error, 'rename mindmap');
  }
}

export async function moveMindmapToFolder(id: string, folderId: string | undefined): Promise<boolean> {
  try {
    const existing = await db.mindmaps.get(id);
    if (!existing) return false;
    if (folderId) {
      const target = await db.mindmapFolders.get(folderId);
      if (!target || target.deletedAt) return false;
    }
    const now = Date.now();
    const updated: Mindmap = {
      ...existing,
      order: await nextMapOrder(folderId),
      updatedAt: now,
      fieldTimestamps: stampUpdatedFields(existing.fieldTimestamps, ['folderId', 'order'], now),
    };
    if (folderId) updated.folderId = folderId;
    else delete updated.folderId;
    await putMindmapRows([{ table: 'mindmaps', entityType: 'mindmap', row: updated }]);
    return true;
  } catch (error) {
    handleDbError(error, 'move mindmap');
    return false;
  }
}

/** Soft-delete a map and all its nodes. */
export async function deleteMindmap(id: string): Promise<void> {
  try {
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.mindmaps, db.mindmapNodes, db.changeLog], async () => {
      const batch: Array<{ entityType: 'mindmap' | 'mindmapNode'; entityId: string; operation: 'delete' }> = [];
      const map = await db.mindmaps.get(id);
      if (!map || map.deletedAt) return;
      const ft = stampUpdatedFields(map.fieldTimestamps, ['deletedAt'], now);
      await db.mindmaps.update(id, { deletedAt: now, updatedAt: now, fieldTimestamps: ft });
      batch.push({ entityType: 'mindmap', entityId: id, operation: 'delete' });
      const nodes = await db.mindmapNodes.where('mapId').equals(id).toArray();
      for (const n of nodes) {
        if (n.deletedAt) continue;
        const nft = stampUpdatedFields(n.fieldTimestamps, ['deletedAt'], now);
        await db.mindmapNodes.update(n.id, { deletedAt: now, updatedAt: now, fieldTimestamps: nft });
        batch.push({ entityType: 'mindmapNode', entityId: n.id, operation: 'delete' });
      }
      await recordChangeBatchInTx(batch);
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'delete mindmap');
  }
}

/** Restore a soft-deleted map together with all its nodes (Trash). */
export async function restoreMindmap(id: string): Promise<void> {
  try {
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.mindmaps, db.mindmapNodes, db.changeLog], async () => {
      const existing = await db.mindmaps.get(id);
      if (!existing) return;
      const ft = stampUpdatedFields(existing.fieldTimestamps, ['deletedAt'], now);
      await db.mindmaps.update(id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: ft });
      const nodes = await db.mindmapNodes.where('mapId').equals(id).toArray();
      for (const n of nodes) {
        const nft = stampUpdatedFields(n.fieldTimestamps, ['deletedAt'], now);
        await db.mindmapNodes.update(n.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: nft });
      }
      const batch: Array<{ entityType: 'mindmap' | 'mindmapNode'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
      const map = await db.mindmaps.get(id);
      if (map) batch.push({ entityType: 'mindmap', entityId: id, operation: 'upsert', data: map as unknown as Record<string, unknown> });
      const restored = await db.mindmapNodes.where('mapId').equals(id).toArray();
      for (const n of restored) {
        batch.push({ entityType: 'mindmapNode', entityId: n.id, operation: 'upsert', data: n as unknown as Record<string, unknown> });
      }
      await recordChangeBatchInTx(batch);
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'restore mindmap');
  }
}

/** Restore a soft-deleted folder with its whole cascade (like restoring a task list). */
export async function restoreMindmapFolder(id: string): Promise<void> {
  try {
    const now = Date.now();
    await ensureDeviceId();
    const folderIds = [id, ...(await descendantFolderIds(id, true))];
    const folderSet = new Set(folderIds);
    await db.transaction('rw', [db.mindmapFolders, db.mindmaps, db.mindmapNodes, db.changeLog], async () => {
      const batch: Array<{ entityType: 'mindmapFolder' | 'mindmap' | 'mindmapNode'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
      for (const folderId of folderIds) {
        const f = await db.mindmapFolders.get(folderId);
        if (!f) continue;
        const ft = stampUpdatedFields(f.fieldTimestamps, ['deletedAt'], now);
        await db.mindmapFolders.update(folderId, { deletedAt: undefined, updatedAt: now, fieldTimestamps: ft });
        const restored = await db.mindmapFolders.get(folderId);
        if (restored) batch.push({ entityType: 'mindmapFolder', entityId: folderId, operation: 'upsert', data: restored as unknown as Record<string, unknown> });
      }
      const maps = (await db.mindmaps.toArray()).filter((m) => m.folderId && folderSet.has(m.folderId));
      for (const m of maps) {
        const ft = stampUpdatedFields(m.fieldTimestamps, ['deletedAt'], now);
        await db.mindmaps.update(m.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: ft });
        const restoredMap = await db.mindmaps.get(m.id);
        if (restoredMap) batch.push({ entityType: 'mindmap', entityId: m.id, operation: 'upsert', data: restoredMap as unknown as Record<string, unknown> });
        const nodes = await db.mindmapNodes.where('mapId').equals(m.id).toArray();
        for (const n of nodes) {
          const nft = stampUpdatedFields(n.fieldTimestamps, ['deletedAt'], now);
          await db.mindmapNodes.update(n.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: nft });
          const restoredNode = await db.mindmapNodes.get(n.id);
          if (restoredNode) batch.push({ entityType: 'mindmapNode', entityId: n.id, operation: 'upsert', data: restoredNode as unknown as Record<string, unknown> });
        }
      }
      await recordChangeBatchInTx(batch);
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'restore mindmap folder');
  }
}

// --- Nodes ---

export async function createMindmapNode(mapId: string, parentId: string, label = 'New node'): Promise<MindmapNode | undefined> {
  try {
    const clean = clampMindmapLabel(label);
    if (!clean) return undefined;
    const parent = await db.mindmapNodes.get(parentId);
    if (!parent || parent.deletedAt || parent.mapId !== mapId) return undefined;
    const now = Date.now();
    const node: MindmapNode = {
      id: newId(),
      mapId,
      parentId,
      label: clean,
      order: await nextNodeOrder(mapId, parentId),
      createdAt: now,
      updatedAt: now,
    };
    node.fieldTimestamps = initFieldTimestamps(node as unknown as Record<string, unknown>, now);
    await putMindmapRows([{ table: 'mindmapNodes', entityType: 'mindmapNode', row: node }]);
    return node;
  } catch (error) {
    handleDbError(error, 'create mindmap node');
    return undefined;
  }
}

export async function updateMindmapNodeLabel(id: string, label: string): Promise<boolean> {
  try {
    const clean = clampMindmapLabel(label);
    if (!clean) return false;
    const existing = await db.mindmapNodes.get(id);
    if (!existing) return false;
    if (existing.label === clean) return true;
    const now = Date.now();
    const updated: MindmapNode = {
      ...existing,
      label: clean,
      updatedAt: now,
      fieldTimestamps: stampUpdatedFields(existing.fieldTimestamps, ['label'], now),
    };
    await putMindmapRows([{ table: 'mindmapNodes', entityType: 'mindmapNode', row: updated }]);
    return true;
  } catch (error) {
    handleDbError(error, 'update mindmap node');
    return false;
  }
}

/**
 * Re-parent a node under a new parent in the same map, appended at the end of
 * the target's children. Rejects: the root, self, own descendants, cross-map.
 */
export async function reparentMindmapNode(id: string, newParentId: string): Promise<boolean> {
  try {
    const node = await db.mindmapNodes.get(id);
    if (!node || node.deletedAt || !node.parentId) return false; // root or gone
    if (newParentId === id || newParentId === node.parentId) return false;
    const target = await db.mindmapNodes.get(newParentId);
    if (!target || target.deletedAt || target.mapId !== node.mapId) return false;
    const descendants = await descendantNodeIds(id, node.mapId);
    if (descendants.has(newParentId)) return false;

    const now = Date.now();
    const updated: MindmapNode = {
      ...node,
      parentId: newParentId,
      order: await nextNodeOrder(node.mapId, newParentId),
      updatedAt: now,
      fieldTimestamps: stampUpdatedFields(node.fieldTimestamps, ['parentId', 'order'], now),
    };
    await putMindmapRows([{ table: 'mindmapNodes', entityType: 'mindmapNode', row: updated }]);
    return true;
  } catch (error) {
    handleDbError(error, 'reparent mindmap node');
    return false;
  }
}

/** Soft-delete a node and its whole subtree. The root cannot be deleted. */
export async function deleteMindmapNodeSubtree(id: string): Promise<void> {
  try {
    const node = await db.mindmapNodes.get(id);
    if (!node || node.deletedAt || !node.parentId) return; // root: delete the map instead
    const descendants = await descendantNodeIds(id, node.mapId);
    const ids = [id, ...descendants];
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.mindmapNodes, db.changeLog], async () => {
      const batch: Array<{ entityType: 'mindmapNode'; entityId: string; operation: 'delete' }> = [];
      for (const nodeId of ids) {
        const n = await db.mindmapNodes.get(nodeId);
        if (!n || n.deletedAt) continue;
        const ft = stampUpdatedFields(n.fieldTimestamps, ['deletedAt'], now);
        await db.mindmapNodes.update(nodeId, { deletedAt: now, updatedAt: now, fieldTimestamps: ft });
        batch.push({ entityType: 'mindmapNode', entityId: nodeId, operation: 'delete' });
      }
      await recordChangeBatchInTx(batch);
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'delete mindmap node');
  }
}

// --- Outline import ---

export interface OutlineNode {
  label: string;
  children: OutlineNode[];
}

function countOutlineNodes(nodes: OutlineNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countOutlineNodes(n.children), 0);
}

/**
 * Create a whole map from a parsed outline in one batch (one transaction, one
 * shared timestamp, root-first order). Triggers an immediate full sync above
 * ~50 nodes — the background trickle (10 entries/30s) would otherwise take
 * many minutes to propagate a large import.
 */
export async function createMindmapFromOutline(
  name: string,
  rootLabel: string,
  children: OutlineNode[],
  folderId?: string,
): Promise<Mindmap | undefined> {
  try {
    const cleanName = clampMindmapLabel(name) ?? 'Imported map';
    const total = 1 + countOutlineNodes(children);
    if (total > MAX_MINDMAP_IMPORT_NODES) {
      throw new Error(`Outline has ${total} nodes (max ${MAX_MINDMAP_IMPORT_NODES})`);
    }

    const now = Date.now();
    const map: Mindmap = {
      id: newId(),
      name: cleanName,
      ...(folderId ? { folderId } : {}),
      order: await nextMapOrder(folderId),
      createdAt: now,
      updatedAt: now,
    };
    map.fieldTimestamps = initFieldTimestamps(map as unknown as Record<string, unknown>, now);

    const nodes: MindmapNode[] = [];
    const makeNode = (label: string, parentId: string | undefined, order: number): MindmapNode => {
      const clean = clampMindmapLabel(label) ?? '…';
      const node: MindmapNode = {
        id: newId(),
        mapId: map.id,
        ...(parentId ? { parentId } : {}),
        label: clean,
        order,
        createdAt: now,
        updatedAt: now,
      };
      node.fieldTimestamps = initFieldTimestamps(node as unknown as Record<string, unknown>, now);
      nodes.push(node);
      return node;
    };
    const root = makeNode(clampMindmapLabel(rootLabel) ?? cleanName, undefined, 0);
    const addChildren = (parent: MindmapNode, outlineChildren: OutlineNode[]) => {
      outlineChildren.forEach((child, i) => {
        const childNode = makeNode(child.label, parent.id, i);
        addChildren(childNode, child.children);
      });
    };
    addChildren(root, children);

    await putMindmapRows([
      { table: 'mindmaps', entityType: 'mindmap', row: map },
      ...nodes.map((n) => ({ table: 'mindmapNodes' as const, entityType: 'mindmapNode' as const, row: n })),
    ]);

    if (nodes.length > 50) void syncNow();
    return map;
  } catch (error) {
    handleDbError(error, 'import mindmap outline');
    return undefined;
  }
}
