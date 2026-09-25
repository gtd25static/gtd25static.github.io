import Dexie, { type Table } from 'dexie';
import type { TaskList, Task, Subtask, SyncMeta, LocalSettings, ChangeEntry, PomodoroSound, SoundPreset, PomodoroSettings, Vault, SharedItem, SharedBlob, MindmapFolder, Mindmap, MindmapNode } from './models';
import { newId } from '../lib/id';
import { createLocalBackup } from './backup';
import { purgeOldTrashItems, expireArchivedLists, expireCompletedItems } from './purge';
import { ensureDeviceId, recordChangeBatchInTx, pruneChangelogIfSyncDisabled } from '../sync/change-log';
import { initFieldTimestamps, stampUpdatedFields } from '../sync/field-timestamps';
import { INBOX_LIST_NAME, pickInboxList } from '../lib/constants';
import { SYNC_VERSION } from '../sync/version';
import { runLocalMigrations } from '../sync/local-migrations';
import { vaultMiddleware } from './vault-middleware';
import { warningIndexMiddleware, normaliseWarningsInStore } from './warning-index';

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
    // No schema change: warnings stored as `true` (not indexable) become 1 so the
    // hasWarning index — and with it Attention — finally sees them. See warning-index.ts.
    this.version(9).stores({}).upgrade(async (tx) => {
      const idbTx = (tx as unknown as { idbtrans: IDBTransaction }).idbtrans;
      await normaliseWarningsInStore(idbTx.objectStore('tasks'));
      await normaliseWarningsInStore(idbTx.objectStore('subtasks'));
    });
  }
}

export const db = new Gtd25DB();

// At-rest encryption chokepoint for Paranoid Mode. No-op until the vault wires
// up a key provider (see src/db/vault-middleware.ts); registering it here is
// inert while Paranoid Mode is off.
db.use(vaultMiddleware);
db.use(warningIndexMiddleware);

// --- Another connection wants this database's schema (or the database gone) ---
//
// Deploy a build with a new `version(N)` and the first tab to reload upgrades the
// schema. Dexie's built-in handler then closes THIS tab's connection so the
// upgrade isn't blocked — but with auto-open still enabled, so the next query
// re-opens declaring the version this (older) tab's code knows, which IndexedDB
// rejects. The old tab is left with failing live queries and a console warning
// nobody sees. Now it says so and offers the only real fix: reload.
let databaseClosedHandler: (() => void) | null = null;

/** Called when another connection upgrades or deletes the database under us. */
export function onDatabaseSupersededByOtherTab(handler: () => void): () => void {
  databaseClosedHandler = handler;
  return () => { databaseClosedHandler = null; };
}

db.on('versionchange', () => {
  // Dexie's own handler closes the connection; we only have to surface it.
  databaseClosedHandler?.();
});

export async function cleanOrphans() {
  const now = Date.now();
  let orphanedSubtasks = 0;
  let orphanedTasks = 0;

  await ensureDeviceId();
  await db.transaction('rw', [db.taskLists, db.tasks, db.subtasks, db.changeLog], async () => {
    const changeBatch: Array<{ entityType: 'taskList' | 'task' | 'subtask'; entityId: string; operation: 'upsert'; data: Record<string, unknown> }> = [];
    // Each table is read once (on a Paranoid device every read decrypts every
    // row, which on a large database is what makes this slow); the fixes below
    // work on these copies and are written back in one bulkPut per table.
    const lists = await db.taskLists.toArray();
    const tasks = await db.tasks.toArray();
    const subtasks = await db.subtasks.toArray();
    const changedTasks = new Map<string, Task>();
    const changedSubtasks = new Map<string, Subtask>();
    const fixTask = (task: Task, changes: Partial<Task>): Task => {
      const fieldTimestamps = stampUpdatedFields(task.fieldTimestamps, Object.keys(changes), now);
      const next = { ...task, ...changes, updatedAt: now, fieldTimestamps };
      changedTasks.set(task.id, next);
      return next;
    };
    const fixSubtask = (sub: Subtask, changes: Partial<Subtask>): Subtask => {
      const fieldTimestamps = stampUpdatedFields(sub.fieldTimestamps, Object.keys(changes), now);
      const next = { ...sub, ...changes, updatedAt: now, fieldTimestamps };
      changedSubtasks.set(sub.id, next);
      return next;
    };

    // Subtasks whose parent task doesn't exist
    const taskIds = new Set(tasks.map((t) => t.id));
    for (const sub of subtasks) {
      if (!taskIds.has(sub.taskId) && !sub.deletedAt) {
        fixSubtask(sub, { deletedAt: now });
        orphanedSubtasks++;
      }
    }

    // Tasks whose parent list doesn't exist → move them to the Inbox, creating
    // one if needed. (Trashing them instead looped: restoring one left it
    // pointing at the missing list, and the next startup trashed it again.)
    const listIds = new Set(lists.map((l) => l.id));
    const orphans = tasks.filter((t) => !listIds.has(t.listId) && !t.deletedAt);
    let inbox: TaskList | undefined = pickInboxList(lists);
    if (orphans.length > 0 && !inbox) {
      inbox = { id: newId(), name: INBOX_LIST_NAME, type: 'tasks', order: lists.length, createdAt: now, updatedAt: now };
      inbox.fieldTimestamps = initFieldTimestamps(inbox as unknown as Record<string, unknown>, now);
      await db.taskLists.add(inbox);
      changeBatch.push({ entityType: 'taskList', entityId: inbox.id, operation: 'upsert', data: inbox as unknown as Record<string, unknown> });
    }
    for (const task of orphans) {
      fixTask(task, { listId: inbox!.id });
      orphanedTasks++;
    }

    // Follow-ups have no done state and no recurrence, but Attention's "Done" set
    // status 'done' on them and the add/edit forms let them recur (GUI review):
    // such a follow-up stayed an active card with nothing showing why. Resolve it
    // — what the "Done" meant — and drop the recurrence and any completion time
    // (a done task moved in kept its own), as moving a task into a follow-up
    // list now does.
    const followUpLists = new Set(lists.filter((l) => l.type === 'follow-ups').map((l) => l.id));
    for (const original of tasks) {
      const task = changedTasks.get(original.id) ?? original;
      if (task.deletedAt || !followUpLists.has(task.listId)) continue;
      const repair: Partial<Task> = {};
      if (task.status === 'done') Object.assign(repair, { status: 'todo', archived: true });
      if (task.completedAt != null) repair.completedAt = undefined;
      if (task.recurrenceType) {
        Object.assign(repair, {
          recurrenceType: undefined, recurrenceInterval: undefined, recurrenceUnit: undefined,
          nextOccurrence: undefined, lastCompletedAt: undefined,
        });
      }
      if (Object.keys(repair).length > 0) fixTask(task, repair);
    }

    // Live children of a parent in the Trash — another device deleted the list
    // (or task) while this one added to it — were invisible until the parent was
    // restored. They join the parent's cascade: its exact deletedAt, so restoring
    // the parent brings them back and deleting it forever removes them. Recorded
    // as upserts carrying that deletedAt: a delete entry would stamp its own time
    // on the other devices and break the equality the cascade restore relies on.
    const deletedListAt = new Map(lists.filter((l) => l.deletedAt).map((l) => [l.id, l.deletedAt!]));
    const deletedTaskAt = new Map<string, number>();
    for (const original of tasks) {
      const task = changedTasks.get(original.id) ?? original;
      if (task.deletedAt) { deletedTaskAt.set(task.id, task.deletedAt); continue; }
      const cascadeAt = deletedListAt.get(task.listId);
      if (!cascadeAt) continue;
      fixTask(task, { deletedAt: cascadeAt });
      deletedTaskAt.set(task.id, cascadeAt);
    }
    for (const original of subtasks) {
      const sub = changedSubtasks.get(original.id) ?? original;
      const cascadeAt = deletedTaskAt.get(sub.taskId);
      if (sub.deletedAt || !cascadeAt) continue;
      fixSubtask(sub, { deletedAt: cascadeAt });
    }

    if (changedTasks.size > 0) await db.tasks.bulkPut([...changedTasks.values()]);
    if (changedSubtasks.size > 0) await db.subtasks.bulkPut([...changedSubtasks.values()]);
    for (const task of changedTasks.values()) {
      changeBatch.push({ entityType: 'task', entityId: task.id, operation: 'upsert', data: task as unknown as Record<string, unknown> });
    }
    for (const sub of changedSubtasks.values()) {
      changeBatch.push({ entityType: 'subtask', entityId: sub.id, operation: 'upsert', data: sub as unknown as Record<string, unknown> });
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

  // Lists archived over 12 months ago move to the Trash, then the 30-day purge
  // below (next startup at the earliest) hard-deletes them.
  await expireArchivedLists();

  // Tasks completed and follow-ups resolved over 12 months ago, likewise.
  await expireCompletedItems();

  // Purge soft-deleted items older than 30 days at startup
  await purgeOldTrashItems();

  // Cap changelog when sync is disabled to prevent unbounded growth
  await pruneChangelogIfSyncDisabled();

  // Defer backup so it doesn't block initial render
  setTimeout(() => createLocalBackup({ reason: 'boot' }), 5000);

  // Run local migrations if needed
  const current = await db.localSettings.get('local');
  const appliedVersion = current?.appliedSyncVersion ?? 0;
  if (appliedVersion < SYNC_VERSION) {
    await runLocalMigrations(db, appliedVersion, SYNC_VERSION);
    await db.localSettings.update('local', { appliedSyncVersion: SYNC_VERSION });
  }
}
