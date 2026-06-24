/**
 * Merge near-duplicate tasks/follow-ups within a single list into one survivor,
 * folding the others' content into it and soft-deleting them. Mirrors the atomic
 * multi-entity pattern of `deleteTask` / `convertSubtaskToTask`: one transaction
 * over [tasks, subtasks, changeLog], per-field timestamps, a single change batch,
 * then a debounced sync. Only encrypted content fields are combined — no new
 * plaintext is introduced (see THREAT_MODEL.md).
 */

import { db } from '../db';
import type { Task, TaskLink, DiscussionEntry } from '../db/models';
import { recordChangeBatchInTx, ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { stampUpdatedFields } from '../sync/field-timestamps';
import { handleDbError } from '../lib/db-error';
import { MAX_DESCRIPTION_LENGTH } from '../lib/constants';

const DESC_DIVIDER = '\n\n———\n';

type ChangeBatch = Array<{
  entityType: 'task' | 'subtask';
  entityId: string;
  operation: 'upsert' | 'delete';
  data?: Record<string, unknown>;
}>;

/** Snapshot captured before a merge so it can be reversed (Undo). */
export interface MergeSnapshot {
  survivor: Task; // full survivor row BEFORE the merge
  sources: Task[]; // full source rows BEFORE soft-delete
  reparented: Array<{ id: string; fromTaskId: string }>; // subtasks moved to survivor
}

/**
 * Combine the sources' content into the survivor. Returns only the fields that
 * change (everything not listed here keeps the survivor's value — title, order,
 * status, follow-up snooze fields, etc.). Exported for preview + unit tests.
 */
export function combineTaskContent(survivor: Task, sources: Task[]): Partial<Task> {
  const updates: Partial<Task> = {};

  // description: survivor first, then each source's, skipping blanks/duplicates.
  const parts: string[] = [];
  const addDesc = (d?: string) => {
    const t = d?.trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (parts.some((p) => p.toLowerCase().includes(key))) return;
    parts.push(t);
  };
  addDesc(survivor.description);
  for (const s of sources) addDesc(s.description);
  const combinedDesc = parts.join(DESC_DIVIDER);
  if (combinedDesc && combinedDesc !== (survivor.description ?? '')) {
    updates.description = combinedDesc.slice(0, MAX_DESCRIPTION_LENGTH);
  }

  // links: union by URL of survivor.links + each source's link/links. The
  // survivor's primary `link` stays primary and is excluded from the secondary list.
  const seen = new Set<string>();
  const primary = survivor.link?.trim().toLowerCase();
  if (primary) seen.add(primary);
  const mergedLinks: TaskLink[] = [];
  const addLink = (l?: TaskLink) => {
    const url = l?.url?.trim();
    if (!url) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    mergedLinks.push(l!.title ? { url, title: l!.title } : { url });
  };
  for (const l of survivor.links ?? []) addLink(l);
  for (const s of sources) {
    if (s.link) addLink({ url: s.link, title: s.linkTitle });
    for (const l of s.links ?? []) addLink(l);
  }
  const prev = survivor.links ?? [];
  const linksChanged =
    mergedLinks.length !== prev.length ||
    mergedLinks.some((l, i) => l.url !== prev[i]?.url || l.title !== prev[i]?.title);
  if (mergedLinks.length > 0 && linksChanged) updates.links = mergedLinks;

  // discussionLog: union by entry id, oldest-first by `at` (matches the
  // id-keyed union the sync layer applies across devices).
  const byId = new Map<string, DiscussionEntry>();
  for (const e of survivor.discussionLog ?? []) byId.set(e.id, e);
  let logChanged = false;
  for (const s of sources) {
    for (const e of s.discussionLog ?? []) {
      if (!byId.has(e.id)) {
        byId.set(e.id, e);
        logChanged = true;
      }
    }
  }
  if (logChanged) {
    updates.discussionLog = [...byId.values()].sort(
      (a, b) => a.at - b.at || a.id.localeCompare(b.id),
    );
  }

  // dueDate: keep survivor's; otherwise take the earliest source due date.
  if (survivor.dueDate === undefined) {
    const earliest = sources
      .map((s) => s.dueDate)
      .filter((d): d is number => typeof d === 'number')
      .sort((a, b) => a - b)[0];
    if (earliest !== undefined) updates.dueDate = earliest;
  }

  // Flags: OR them in.
  if (!survivor.starred && sources.some((s) => s.starred)) updates.starred = true;
  if (!survivor.hasWarning && sources.some((s) => s.hasWarning)) updates.hasWarning = true;

  return updates;
}

/**
 * Merge `sourceIds` into `survivorId` (same list). Returns a snapshot for Undo,
 * or `undefined` if nothing was merged.
 */
export async function mergeTasks(
  survivorId: string,
  sourceIds: string[],
): Promise<MergeSnapshot | undefined> {
  try {
    const ids = [...new Set(sourceIds)].filter((id) => id !== survivorId);
    if (ids.length === 0) return undefined;
    const now = Date.now();
    await ensureDeviceId();
    let snapshot: MergeSnapshot | undefined;

    await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
      const survivor = await db.tasks.get(survivorId);
      if (!survivor || survivor.deletedAt) return;
      const sources: Task[] = [];
      for (const id of ids) {
        const s = await db.tasks.get(id);
        if (s && !s.deletedAt && s.listId === survivor.listId) sources.push(s);
      }
      if (sources.length === 0) return;

      const batch: ChangeBatch = [];

      // Re-parent live subtasks from the sources onto the survivor, appended
      // after the survivor's existing subtasks.
      const reparented: Array<{ id: string; fromTaskId: string }> = [];
      let orderBase = await db.subtasks.where('taskId').equals(survivorId).count();
      for (const src of sources) {
        const subs = (await db.subtasks.where('taskId').equals(src.id).toArray())
          .filter((s) => !s.deletedAt)
          .sort((a, b) => a.order - b.order);
        for (const sub of subs) {
          const ft = stampUpdatedFields(sub.fieldTimestamps, ['taskId', 'order'], now);
          await db.subtasks.update(sub.id, {
            taskId: survivorId,
            order: orderBase++,
            updatedAt: now,
            fieldTimestamps: ft,
          });
          reparented.push({ id: sub.id, fromTaskId: src.id });
          const updated = await db.subtasks.get(sub.id);
          if (updated) {
            batch.push({
              entityType: 'subtask',
              entityId: sub.id,
              operation: 'upsert',
              data: updated as unknown as Record<string, unknown>,
            });
          }
        }
      }

      // Fold content into the survivor.
      const updates = combineTaskContent(survivor, sources);
      const survivorFT = stampUpdatedFields(survivor.fieldTimestamps, Object.keys(updates), now);
      const survivorUpdated: Task = { ...survivor, ...updates, updatedAt: now, fieldTimestamps: survivorFT };
      await db.tasks.put(survivorUpdated);
      batch.push({
        entityType: 'task',
        entityId: survivorId,
        operation: 'upsert',
        data: survivorUpdated as unknown as Record<string, unknown>,
      });

      // Soft-delete the sources (recoverable from Trash / via Undo).
      for (const src of sources) {
        const ft = stampUpdatedFields(src.fieldTimestamps, ['deletedAt'], now);
        await db.tasks.update(src.id, { deletedAt: now, updatedAt: now, fieldTimestamps: ft });
        batch.push({ entityType: 'task', entityId: src.id, operation: 'delete' });
      }

      await recordChangeBatchInTx(batch);
      snapshot = { survivor, sources, reparented };
    });

    scheduleSyncDebounced();
    return snapshot;
  } catch (error) {
    handleDbError(error, 'merge tasks');
    return undefined;
  }
}

/** Reverse a merge: restore the survivor's pre-merge content, re-parent the
 * moved subtasks back, and un-delete the sources. */
export async function unmergeTasks(snapshot: MergeSnapshot): Promise<void> {
  try {
    const now = Date.now();
    await ensureDeviceId();
    await db.transaction('rw', [db.tasks, db.subtasks, db.changeLog], async () => {
      const batch: ChangeBatch = [];

      const ft = stampUpdatedFields(
        snapshot.survivor.fieldTimestamps,
        Object.keys(snapshot.survivor),
        now,
      );
      const restored: Task = { ...snapshot.survivor, updatedAt: now, fieldTimestamps: ft };
      await db.tasks.put(restored);
      batch.push({
        entityType: 'task',
        entityId: restored.id,
        operation: 'upsert',
        data: restored as unknown as Record<string, unknown>,
      });

      for (const rp of snapshot.reparented) {
        const sub = await db.subtasks.get(rp.id);
        if (!sub) continue;
        const sft = stampUpdatedFields(sub.fieldTimestamps, ['taskId'], now);
        await db.subtasks.update(rp.id, { taskId: rp.fromTaskId, updatedAt: now, fieldTimestamps: sft });
        const updated = await db.subtasks.get(rp.id);
        if (updated) {
          batch.push({
            entityType: 'subtask',
            entityId: rp.id,
            operation: 'upsert',
            data: updated as unknown as Record<string, unknown>,
          });
        }
      }

      for (const src of snapshot.sources) {
        const sft = stampUpdatedFields(src.fieldTimestamps, ['deletedAt'], now);
        await db.tasks.update(src.id, { deletedAt: undefined, updatedAt: now, fieldTimestamps: sft });
        const updated = await db.tasks.get(src.id);
        if (updated) {
          batch.push({
            entityType: 'task',
            entityId: src.id,
            operation: 'upsert',
            data: updated as unknown as Record<string, unknown>,
          });
        }
      }

      await recordChangeBatchInTx(batch);
    });
    scheduleSyncDebounced();
  } catch (error) {
    handleDbError(error, 'unmerge tasks');
  }
}
