// Edits made on two devices that had not seen each other's — detected, kept, and
// put in front of the user (2026-10-05, user decision: free-text fields only;
// a delete against an edit counts too; nothing blocks — the newer version is
// applied meanwhile, as before, and the other is kept until the user picks).
//
// How a device knows two edits were concurrent. Every row carries `_base`: per
// field, the newest timestamp this device has seen arrive FROM the remote. A
// local edit stamps the field (fieldTimestamps) and leaves `_base` alone, so
// "changed here since the remote state I knew" is `fieldTimestamps[f] > _base[f]`.
// Each change entry carries the whole row, so its `_base` travels with it: the
// device receiving it learns what the writer had seen. Field f of an incoming
// row conflicts with the local row when
//   - it changed here since the base (local[f] newer than local._base[f]),
//   - the incoming value is newer than anything seen here (remote[f] > local._base[f]),
//   - it changed there since the writer's base (remote[f] > remote._base[f]),
//   - the writer had not seen ours (remote._base[f] < local[f]),
//   - and the values differ.
// Both devices run this on the other's entry, so both see the conflict. A
// snapshot row (folded in by compaction) carries no writer's base: there only an
// edit still waiting to be pushed is known to be unseen, so only then is it
// flagged — after compaction, the device that pushed first may miss it.
//
// Rows older than this feature have no `_base`. Taking that as "nothing seen"
// would make every field look edited here and every remote edit a conflict, so
// until a row gets one, its base is implicit: its field timestamps up to the
// moment this version started (SyncMeta.conflictBaseSince) — what was on the
// device then counts as synced. Its entries get that base filled in at push.

import type { Table } from 'dexie';
import { db } from '../db';
import type { SyncConflict, DiscussionEntry } from '../db/models';
import { sameFieldValue } from './field-timestamps';
import { isParanoidFlagSet } from '../db/paranoid-flag';
import { getActiveAtRestKey } from '../db/vault-middleware';
import { recordError } from '../lib/diagnostics';

type Entity = Record<string, unknown>;
type Timestamps = Record<string, number>;
export type ConflictEntityType = SyncConflict['entityType'];

/** The free-text fields a conflict is raised for (scalar fields keep plain last-writer-wins). */
export const CONFLICT_FIELDS: Record<ConflictEntityType, string[]> = {
  task: ['title', 'description', 'link', 'linkTitle', 'links'],
  subtask: ['title', 'link', 'linkTitle', 'links'],
  taskList: ['name'],
  mindmapFolder: ['name'],
  mindmap: ['name'],
  mindmapNode: ['label'],
};

/** Unresolved conflicts older than this are dropped (the applied version stays). */
export const CONFLICT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function isConflictEntity(entityType: string): entityType is ConflictEntityType {
  return entityType in CONFLICT_FIELDS;
}

function ft(row: Entity | undefined): Timestamps {
  return (row?.fieldTimestamps ?? {}) as Timestamps;
}

/**
 * A row's base: its own `_base`, or the implicit one of a row older than this
 * feature (see the header) — its field timestamps up to `since`.
 */
export function effectiveBase(row: Entity | undefined, since: number): Timestamps {
  if (row?._base) return row._base as Timestamps;
  const out: Timestamps = {};
  for (const [field, at] of Object.entries(ft(row))) if (typeof at === 'number' && at <= since) out[field] = at;
  return out;
}

/** The newest remote-known timestamp per field once `remoteFT` arrived; the same object when nothing advanced. */
export function advanceBase(current: Timestamps | undefined, remoteFT: Timestamps | undefined): Timestamps | undefined {
  if (!remoteFT) return current;
  let next: Timestamps | undefined;
  for (const [field, at] of Object.entries(remoteFT)) {
    if (typeof at === 'number' && Number.isFinite(at) && at > (current?.[field] ?? 0)) {
      next ??= { ...(current ?? {}) };
      next[field] = at;
    }
  }
  return next ?? current;
}

/** A label for the conflict list: the item's title, name or node label. */
export function labelOf(row: Entity): string | undefined {
  const label = row.title ?? row.name ?? row.label;
  return typeof label === 'string' ? label : undefined;
}

/** Field f was changed on both sides without either seeing the other (see the header). */
function concurrent(field: string, local: Entity, localBaseAll: Timestamps, remote: Entity, remoteBase: Timestamps | null): boolean {
  const localAt = ft(local)[field] ?? 0;
  const localBase = localBaseAll[field] ?? 0;
  const remoteAt = ft(remote)[field] ?? 0;
  if (localAt <= localBase) return false; // not changed here since the remote state known here
  if (remoteAt <= localBase) return false; // nothing newer from there than what was known
  if (localAt === remoteAt) return false; // the same write
  if (remoteBase) {
    const writerBase = remoteBase[field] ?? 0;
    if (remoteAt <= writerBase) return false; // not changed there
    if (writerBase >= localAt) return false; // the writer had seen this one
  }
  return true;
}

function idOf(entityType: string, entityId: string, field: string, localAt: number, remoteAt: number): string {
  return `${entityType}:${entityId}:${field}:${localAt}:${remoteAt}`;
}

function changedFields(entityType: ConflictEntityType, row: Entity, base: Timestamps): string[] {
  const at = ft(row);
  return [...CONFLICT_FIELDS[entityType], ...(entityType === 'task' ? ['discussionLog'] : [])]
    .filter((field) => (at[field] ?? 0) > (base[field] ?? 0));
}

/**
 * The conflicts between a local row and an incoming version of it.
 * `remoteBase`: the incoming row's `_base` when it came in a change entry; null
 * for a snapshot row — the caller then passes `localPending` (an edit of this
 * item is still waiting to be pushed: unseen by anyone), and nothing is flagged
 * without it.
 */
export function detectConflicts(
  entityType: ConflictEntityType,
  local: Entity,
  remote: Entity,
  remoteBase: Timestamps | null,
  opts: { localPending?: boolean; now?: number; since?: number } = {},
): SyncConflict[] {
  if (local._decryptError || remote._decryptError) return []; // a placeholder is not a version
  if (!remoteBase && !opts.localPending) return [];
  const now = opts.now ?? Date.now();
  const localBase = effectiveBase(local, opts.since ?? 0);
  const entityId = String(local.id);
  const label = labelOf(local) ?? labelOf(remote);
  const out: SyncConflict[] = [];

  for (const field of CONFLICT_FIELDS[entityType]) {
    if (!concurrent(field, local, localBase, remote, remoteBase)) continue;
    if (sameFieldValue(local[field], remote[field])) continue;
    const localAt = ft(local)[field] ?? 0;
    const remoteAt = ft(remote)[field] ?? 0;
    out.push({
      id: idOf(entityType, entityId, field, localAt, remoteAt), entityType, entityId, field, kind: 'field',
      localValue: local[field], remoteValue: remote[field], localAt, remoteAt,
      applied: remoteAt > localAt ? 'remote' : 'local', label, detectedAt: now,
    });
  }

  // A discussion note edited on both sides: the log is merged as a union, so only
  // an entry present on both with different content is a conflict.
  if (entityType === 'task' && concurrent('discussionLog', local, localBase, remote, remoteBase)) {
    const localAt = ft(local).discussionLog ?? 0;
    const remoteAt = ft(remote).discussionLog ?? 0;
    const theirs = new Map(((remote.discussionLog ?? []) as DiscussionEntry[]).map((e) => [e.id, e]));
    for (const mine of (local.discussionLog ?? []) as DiscussionEntry[]) {
      const other = theirs.get(mine.id);
      if (!other || sameFieldValue(mine, other)) continue;
      const field = `discussionLog:${mine.id}`;
      out.push({
        id: idOf(entityType, entityId, field, localAt, remoteAt), entityType, entityId, field, kind: 'field',
        localValue: mine.note, remoteValue: other.note, localAt, remoteAt,
        applied: remoteAt > localAt ? 'remote' : 'local', label, detectedAt: now,
      });
    }
  }

  // Deleted on one side, edited on the other.
  const localDeleted = !!local.deletedAt;
  if (localDeleted !== !!remote.deletedAt) {
    const deleter = localDeleted ? local : remote;
    const deletedAt = ft(deleter).deletedAt ?? (typeof deleter.deletedAt === 'number' ? deleter.deletedAt : 0);
    let edits: string[];
    let deleteUnseen: boolean;
    if (localDeleted) {
      // Deleted here: news to the writer, and an edit there newer than what was known here.
      deleteUnseen = deletedAt > (localBase.deletedAt ?? 0) && (!remoteBase || (remoteBase.deletedAt ?? 0) < deletedAt);
      edits = CONFLICT_FIELDS[entityType].filter((f) => (ft(remote)[f] ?? 0) > (localBase[f] ?? 0)
        && (!remoteBase || (ft(remote)[f] ?? 0) > (remoteBase[f] ?? 0)));
    } else {
      // Deleted there: news here, and an edit here the writer had not seen.
      deleteUnseen = deletedAt > (localBase.deletedAt ?? 0);
      edits = changedFields(entityType, local, localBase).filter((f) => !remoteBase || (remoteBase[f] ?? 0) < (ft(local)[f] ?? 0));
    }
    if (deleteUnseen && edits.length > 0) {
      const editor = localDeleted ? remote : local;
      const editedAt = Math.max(...edits.map((f) => ft(editor)[f] ?? 0));
      const localAt = localDeleted ? deletedAt : editedAt;
      const remoteAt = localDeleted ? editedAt : deletedAt;
      out.push({
        id: idOf(entityType, entityId, '', localAt, remoteAt), entityType, entityId, field: '',
        kind: localDeleted ? 'deleted-locally' : 'deleted-remotely', localAt, remoteAt,
        applied: (ft(remote).deletedAt ?? 0) > (ft(local).deletedAt ?? 0) ? 'remote' : 'local',
        label, detectedAt: now,
      });
    }
  }
  return out;
}

/**
 * A delete entry (no data) for an item edited here. A delete entry carries no
 * writer's base, so the edit counts as unseen when it is still waiting to be
 * pushed, or was made after the delete.
 */
export function detectDeleteConflict(
  entityType: ConflictEntityType,
  local: Entity,
  deletedAt: number,
  opts: { localPending?: boolean; now?: number; since?: number } = {},
): SyncConflict | null {
  if (local._decryptError || local.deletedAt) return null;
  const edits = changedFields(entityType, local, effectiveBase(local, opts.since ?? 0));
  if (edits.length === 0) return null;
  const editedAt = Math.max(...edits.map((f) => ft(local)[f] ?? 0));
  if (!opts.localPending && editedAt <= deletedAt) return null;
  const entityId = String(local.id);
  return {
    id: idOf(entityType, entityId, '', editedAt, deletedAt), entityType, entityId, field: '', kind: 'deleted-remotely',
    localAt: editedAt, remoteAt: deletedAt,
    applied: deletedAt >= (ft(local).deletedAt ?? 0) ? 'remote' : 'local',
    label: labelOf(local), detectedAt: opts.now ?? Date.now(),
  };
}

/**
 * Whether a recorded conflict no longer stands: the item is gone, or the field
 * (or the delete) changed again after both versions — someone already decided,
 * here or on another device.
 */
export function conflictSuperseded(conflict: SyncConflict, row: Entity | undefined, now = Date.now()): boolean {
  if (!row) return true;
  if (now - conflict.detectedAt > CONFLICT_MAX_AGE_MS) return true;
  const field = conflict.kind === 'field'
    ? (conflict.field.startsWith('discussionLog:') ? 'discussionLog' : conflict.field)
    : 'deletedAt';
  return (ft(row)[field] ?? 0) > Math.max(conflict.localAt, conflict.remoteAt);
}

/** The table each conflict-capable entity lives in. */
export function conflictTable(entityType: ConflictEntityType): Table<Record<string, unknown>, string> {
  const tables = {
    task: db.tasks, subtask: db.subtasks, taskList: db.taskLists,
    mindmapFolder: db.mindmapFolders, mindmap: db.mindmaps, mindmapNode: db.mindmapNodes,
  } as const;
  return tables[entityType] as unknown as Table<Record<string, unknown>, string>;
}

/**
 * Drop the recorded conflicts that no longer stand (see conflictSuperseded): the
 * other device resolved it (its choice arrives as a newer edit of the field), the
 * item was edited again or is gone, or it is older than CONFLICT_MAX_AGE_MS.
 * Not while a Paranoid vault is locked (rows are ciphertext then). Returns how many.
 */
export async function sweepConflicts(now = Date.now()): Promise<number> {
  if (isParanoidFlagSet() && !getActiveAtRestKey()) return 0;
  const open = await db.syncConflicts.toArray();
  if (open.length === 0) return 0;
  const stale: string[] = [];
  for (const conflict of open) {
    if ((conflict as { _decryptError?: boolean })._decryptError) { stale.push(conflict.id); continue; }
    const row = await conflictTable(conflict.entityType).get(conflict.entityId);
    if (conflictSuperseded(conflict, row, now)) stale.push(conflict.id);
  }
  if (stale.length > 0) await db.syncConflicts.bulkDelete(stale);
  return stale.length;
}

export function sweepConflictsSafely(): void {
  void sweepConflicts().catch((err) => recordError('conflicts.sweep', err));
}
