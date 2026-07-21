import Dexie, { type Table } from 'dexie';
import type { TaskList, Task, Subtask, SyncMeta, LocalSettings, ChangeEntry, PomodoroSound, SoundPreset, PomodoroSettings, Vault, SharedItem, SharedBlob, MindmapFolder, Mindmap, MindmapNode } from './models';
import { newId } from '../lib/id';
import { createLocalBackup } from './backup';
import { purgeOldTrashItems } from './purge';
import { ensureDeviceId, recordChangeBatchInTx, pruneChangelogIfSyncDisabled } from '../sync/change-log';
import { stampUpdatedFields } from '../sync/field-timestamps';
import { SYNC_VERSION } from '../sync/version';
import { runLocalMigrations } from '../sync/local-migrations';
import { vaultMiddleware } from './vault-middleware';

export class Gtd25DB extends Dexie {
  taskLists!: Table<TaskList, string>;
  tasks!: Table<Task, string>;
  subtasks!: Table<Subtask, string>;
  syncMeta!: Table<SyncMeta, string>;
  localSettings!: Table<LocalSettings, string>;
  changeLog!: Table<ChangeEntry, string>;
  pomodoroSounds!: Table<PomodoroSound, string>;
  soundPresets!: Table<SoundPreset, string>;
  pomodoroSettings!: Table<PomodoroSettings, string>;
  vault!: Table<Vault, string>;
  sharedItems!: Table<SharedItem, string>;
  sharedBlobs!: Table<SharedBlob, string>;
  mindmapFolders!: Table<MindmapFolder, string>;
  mindmaps!: Table<Mindmap, string>;
  mindmapNodes!: Table<MindmapNode, string>;

  constructor() {
    super('gtd25');
    this.version(1).stores({
      taskLists: 'id, order, deletedAt',
      tasks: 'id, listId, status, order, dueDate, deletedAt',
      subtasks: 'id, taskId, status, order, deletedAt',
      syncMeta: 'id',
      localSettings: 'id',
    });
    this.version(2).stores({
      tasks: 'id, listId, status, order, dueDate, deletedAt, createdAt',
    });
    this.version(3).stores({
      changeLog: 'id, deviceId, timestamp',
    });
    this.version(4).stores({
      tasks: 'id, listId, status, order, dueDate, deletedAt, createdAt, hasWarning, nextOccurrence',
      subtasks: 'id, taskId, status, order, deletedAt, hasWarning',
    });
    this.version(5).stores({
      pomodoroSounds: 'id',
      soundPresets: 'id',
      pomodoroSettings: 'id',
    });
    // Paranoid Mode: device-local vault holding the wrapped at-rest DEK.
    this.version(6).stores({
      vault: 'id',
    });
    // Shared Folder: E2E-encrypted items synced across the user's devices.
    // `sharedItems` holds metadata (synced); `sharedBlobs` caches file/snippet
    // bytes locally (device-local, never synced).
    this.version(7).stores({
      sharedItems: 'id, order, deletedAt',
      sharedBlobs: 'id',
    });
    // Mindmaps: folders / maps / nodes, all synced entities.
    this.version(8).stores({
      mindmapFolders: 'id, parentId, order, deletedAt',
      mindmaps: 'id, folderId, order, deletedAt',
      mindmapNodes: 'id, mapId, parentId, order, deletedAt',
    });
  }
}

export const db = new Gtd25DB();

// At-rest encryption chokepoint for Paranoid Mode. No-op until the vault wires
// up a key provider (see src/db/vault-middleware.ts); registering it here is
// inert while Paranoid Mode is off.
db.use(vaultMiddleware);

export async function cleanOrphans() {
  const now = Date.now();
  let orphanedSubtasks = 0;
  let orphanedTasks = 0;

  await ensureDeviceId();
  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.changeLog], async () => {
    const changeBatch: Array<{ entityType: 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];

    // Find subtasks whose parent task doesn't exist
    const taskIds = new Set((await db.tasks.toArray()).map((t) => t.id));
    const allSubtasks = await db.subtasks.toArray();
    for (const sub of allSubtasks) {
      if (!taskIds.has(sub.taskId) && !sub.deletedAt) {
        const ft = stampUpdatedFields(sub.fieldTimestamps, ['deletedAt'], now);
        await db.subtasks.update(sub.id, { deletedAt: now, updatedAt: now, fieldTimestamps: ft });
        const updated = await db.subtasks.get(sub.id);
        if (updated) changeBatch.push({ entityType: 'subtask', entityId: sub.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
        orphanedSubtasks++;
      }
    }

    // Find tasks whose parent list doesn't exist → move to Inbox or soft-delete
    const listIds = new Set((await db.taskLists.toArray()).map((l) => l.id));
    const allTasks = await db.tasks.toArray();
    const inbox = allTasks.length > 0
      ? (await db.taskLists.toArray()).find((l) => !l.deletedAt && l.name === 'Inbox' && l.type === 'tasks')
      : undefined;

    for (const task of allTasks) {
      if (!listIds.has(task.listId) && !task.deletedAt) {
        if (inbox) {
          const ft = stampUpdatedFields(task.fieldTimestamps, ['listId'], now);
          await db.tasks.update(task.id, { listId: inbox.id, updatedAt: now, fieldTimestamps: ft });
        } else {
          const ft = stampUpdatedFields(task.fieldTimestamps, ['deletedAt'], now);
          await db.tasks.update(task.id, { deletedAt: now, updatedAt: now, fieldTimestamps: ft });
        }
        const updated = await db.tasks.get(task.id);
        if (updated) changeBatch.push({ entityType: 'task', entityId: task.id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
        orphanedTasks++;
      }
    }

    if (changeBatch.length > 0) {
      await recordChangeBatchInTx(changeBatch);
    }
  });

  if (orphanedSubtasks > 0 || orphanedTasks > 0) {
    console.warn(`Orphan cleanup: ${orphanedSubtasks} subtask(s), ${orphanedTasks} task(s)`);
  }

  await cleanMindmapOrphans();
}

// Repair dangling mindmap references left by out-of-order remote entries or
// concurrent reparents (applyRemoteEntries does no referential checks, same as
// tasks). Existence checks are against hard-missing rows only — soft-deleted
// rows still "exist" and are restored/purged through their own lifecycle.
export async function cleanMindmapOrphans() {
  const now = Date.now();
  let repairs = 0;

  await ensureDeviceId();
  await db.transaction('rw', [db.mindmapFolders, db.mindmaps, db.mindmapNodes, db.changeLog], async () => {
    const changeBatch: Array<{ entityType: 'mindmapFolder' | 'mindmap' | 'mindmapNode'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];

    const folders = await db.mindmapFolders.toArray();
    const maps = await db.mindmaps.toArray();
    const nodes = await db.mindmapNodes.toArray();
    const folderIds = new Set(folders.map((f) => f.id));
    const mapIds = new Set(maps.map((m) => m.id));

    async function repairFolder(id: string, changes: Partial<MindmapFolder>, fields: string[]) {
      const row = await db.mindmapFolders.get(id);
      if (!row) return;
      const ft = stampUpdatedFields(row.fieldTimestamps, fields, now);
      await db.mindmapFolders.update(id, { ...changes, updatedAt: now, fieldTimestamps: ft });
      const updated = await db.mindmapFolders.get(id);
      if (updated) changeBatch.push({ entityType: 'mindmapFolder', entityId: id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
      repairs++;
    }

    async function repairMap(id: string, changes: Partial<Mindmap>, fields: string[]) {
      const row = await db.mindmaps.get(id);
      if (!row) return;
      const ft = stampUpdatedFields(row.fieldTimestamps, fields, now);
      await db.mindmaps.update(id, { ...changes, updatedAt: now, fieldTimestamps: ft });
      const updated = await db.mindmaps.get(id);
      if (updated) changeBatch.push({ entityType: 'mindmap', entityId: id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
      repairs++;
    }

    async function repairNode(id: string, changes: Partial<MindmapNode>, fields: string[]) {
      const row = await db.mindmapNodes.get(id);
      if (!row) return;
      const ft = stampUpdatedFields(row.fieldTimestamps, fields, now);
      await db.mindmapNodes.update(id, { ...changes, updatedAt: now, fieldTimestamps: ft });
      const updated = await db.mindmapNodes.get(id);
      if (updated) changeBatch.push({ entityType: 'mindmapNode', entityId: id, operation: 'upsert', data: updated as unknown as Record<string, unknown> });
      repairs++;
    }

    // Folder/map pointing at a hard-missing parent folder → move to top level.
    // Dexie update() can't delete a key, so parentId/folderId are set undefined.
    for (const f of folders) {
      if (f.parentId && !folderIds.has(f.parentId) && !f.deletedAt) {
        await repairFolder(f.id, { parentId: undefined }, ['parentId']);
      }
    }
    for (const m of maps) {
      if (m.folderId && !folderIds.has(m.folderId) && !m.deletedAt) {
        await repairMap(m.id, { folderId: undefined }, ['folderId']);
      }
    }

    // Node whose map is hard-missing → soft-delete.
    const nodeIds = new Set(nodes.map((n) => n.id));
    const liveNodesByMap = new Map<string, MindmapNode[]>();
    for (const n of nodes) {
      if (!mapIds.has(n.mapId)) {
        if (!n.deletedAt) await repairNode(n.id, { deletedAt: now }, ['deletedAt']);
        continue;
      }
      if (n.deletedAt) continue;
      const list = liveNodesByMap.get(n.mapId) ?? [];
      list.push(n);
      liveNodesByMap.set(n.mapId, list);
    }

    // Per map: re-point nodes with a hard-missing parent to the root, then break
    // reparent cycles (all parents exist but a subtree is unreachable from root).
    for (const [, mapNodes] of liveNodesByMap) {
      const byId = new Map(mapNodes.map((n) => [n.id, n]));
      // Deterministic root: oldest createdAt, then smallest id, among no-parent nodes.
      const rootCandidates = mapNodes.filter((n) => !n.parentId)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
      let root = rootCandidates[0];
      if (!root) {
        // No root at all (e.g. full cycle): promote the oldest live node.
        const promoted = [...mapNodes].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0];
        if (!promoted) continue;
        await repairNode(promoted.id, { parentId: undefined }, ['parentId']);
        promoted.parentId = undefined;
        root = promoted;
      }

      for (const n of mapNodes) {
        if (n.parentId && !nodeIds.has(n.parentId)) {
          await repairNode(n.id, { parentId: root.id === n.id ? undefined : root.id }, ['parentId']);
          n.parentId = root.id === n.id ? undefined : root.id;
        }
      }

      // Cycle breaking: BFS from root; while live nodes stay unreachable,
      // re-point one deterministic cycle member to the root and retry.
      for (let guard = 0; guard < mapNodes.length; guard++) {
        const reachable = new Set<string>([root.id]);
        const queue = [root.id];
        while (queue.length > 0) {
          const cur = queue.pop()!;
          for (const n of mapNodes) {
            if (n.parentId === cur && !reachable.has(n.id)) {
              reachable.add(n.id);
              queue.push(n.id);
            }
          }
        }
        const unreachable = mapNodes.filter((n) => !reachable.has(n.id));
        if (unreachable.length === 0) break;
        // Re-point the subtree's attachment point, not an arbitrary descendant:
        // prefer the top of an orphaned subtree (parent soft-deleted, i.e. not
        // among live nodes), then an actual cycle member (walking the parent
        // chain returns to the node itself). Smallest id for determinism.
        const isCycleMember = (n: MindmapNode): boolean => {
          const seen = new Set<string>();
          let cur = n.parentId ? byId.get(n.parentId) : undefined;
          while (cur) {
            if (cur.id === n.id) return true;
            if (seen.has(cur.id)) return false; // a cycle that doesn't include n
            seen.add(cur.id);
            cur = cur.parentId ? byId.get(cur.parentId) : undefined;
          }
          return false;
        };
        const tops = unreachable.filter((n) => n.parentId && !byId.has(n.parentId));
        const cycleMembers = tops.length > 0 ? [] : unreachable.filter(isCycleMember);
        const candidates = tops.length > 0 ? tops : (cycleMembers.length > 0 ? cycleMembers : unreachable);
        const target = candidates.sort((a, b) => (a.id < b.id ? -1 : 1))[0];
        await repairNode(target.id, { parentId: root.id }, ['parentId']);
        target.parentId = root.id;
      }
    }

    if (changeBatch.length > 0) {
      await recordChangeBatchInTx(changeBatch);
    }
  });

  if (repairs > 0) {
    console.warn(`Mindmap orphan cleanup: ${repairs} repair(s)`);
  }
}

export async function ensureDefaults() {
  // Seed pomodoro settings
  const pomSettings = await db.pomodoroSettings.get('pomodoro');
  if (!pomSettings) {
    await db.pomodoroSettings.put({
      id: 'pomodoro',
      masterVolume: 0.7,
      tickingEnabled: true,
      bellEnabled: true,
      activePresetId: null,
      updatedAt: Date.now(),
      dynamicMixEnabled: false,
    });
  }

  await db.transaction('rw', [db.localSettings, db.syncMeta], async () => {
    const local = await db.localSettings.get('local');
    if (!local) {
      await db.localSettings.put({
        id: 'local',
        syncEnabled: false,
        syncIntervalMs: 300_000,
        deviceId: newId(),
        appliedSyncVersion: SYNC_VERSION,
      });
    } else if (!local.deviceId) {
      await db.localSettings.update('local', { deviceId: newId() });
    }
    const meta = await db.syncMeta.get('sync-meta');
    if (!meta) {
      await db.syncMeta.put({
        id: 'sync-meta',
        pendingChanges: false,
      });
    }
  });

  // Clean orphaned records
  await cleanOrphans();

  // Purge soft-deleted items older than 30 days at startup
  await purgeOldTrashItems();

  // Cap changelog when sync is disabled to prevent unbounded growth
  await pruneChangelogIfSyncDisabled();

  // Defer backup so it doesn't block initial render
  setTimeout(() => createLocalBackup(), 5000);

  // Run local migrations if needed
  const current = await db.localSettings.get('local');
  const appliedVersion = current?.appliedSyncVersion ?? 0;
  if (appliedVersion < SYNC_VERSION) {
    await runLocalMigrations(db, appliedVersion, SYNC_VERSION);
    await db.localSettings.update('local', { appliedSyncVersion: SYNC_VERSION });
  }
}
