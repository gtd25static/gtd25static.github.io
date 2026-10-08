import { useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { ChangeEntry, SharedItem } from '../db/models';
import { newId } from '../lib/id';
import { ensureDeviceId } from '../sync/change-log';
import { scheduleSyncDebounced } from '../sync/sync-engine';
import { handleDbError } from '../lib/db-error';
import { initFieldTimestamps, stampUpdatedFields } from '../sync/field-timestamps';
import { encryptRow, getActiveAtRestKey } from '../db/vault-middleware';
import { SYNC_VERSION } from '../sync/version';
import { uploadSharedBlob, deleteSharedBlob, sharedBlobBlocker, withBlobBranchLock } from '../sync/shared-blobs';
import { MAX_SHARED_FOLDER_BYTES, PARANOID_SHARED_ITEM_TTL_MS } from '../lib/constants';
import { isParanoidEnabled } from '../db/vault';
import { isValidUrl } from '../lib/link-utils';
import { toast } from '../components/ui/Toast';
import { useMinuteTick } from './use-minute-tick';

// --- Queries ---

export function useSharedItems(): SharedItem[] {
  return useLiveQuery(
    async () => {
      const all = await db.sharedItems.orderBy('order').toArray();
      return all.filter((i) => !i.deletedAt);
    },
    [],
    [],
  );
}

export interface SharedStorage {
  usedBytes: number;
  totalBytes: number;
  remaining: number;
}

export function useSharedStorage(): SharedStorage {
  const usedBytes = useLiveQuery(currentUsedBytes, [], 0) ?? 0;
  return {
    usedBytes,
    totalBytes: MAX_SHARED_FOLDER_BYTES,
    remaining: Math.max(0, MAX_SHARED_FOLDER_BYTES - usedBytes),
  };
}

// Soft-deleted items don't count toward the quota — deleting frees space at once.
async function currentUsedBytes(): Promise<number> {
  const all = await db.sharedItems.toArray();
  return all.filter((i) => !i.deletedAt).reduce((sum, i) => sum + (i.size || 0), 0);
}

/** `round`: 'up' / 'down' instead of nearest, for sizes that must not look equal. */
export function formatBytes(bytes: number, round: 'nearest' | 'up' | 'down' = 'nearest'): string {
  const fn = round === 'up' ? Math.ceil : round === 'down' ? Math.floor : Math.round;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${fn(bytes / 1024)} KB`;
  return `${(fn(bytes / (1024 * 1024) * 10) / 10).toFixed(1)} MB`;
}

// --- Internal write helper (mirrors the Safari-safe pre-encrypt dance in use-tasks) ---

async function putSharedItem(item: SharedItem): Promise<void> {
  const deviceId = await ensureDeviceId();
  const change: ChangeEntry = {
    id: newId(),
    deviceId,
    timestamp: item.updatedAt,
    entityType: 'sharedItem',
    entityId: item.id,
    operation: 'upsert',
    data: item as unknown as Record<string, unknown>,
    v: SYNC_VERSION,
  };

  let itemRow = item as unknown as Record<string, unknown>;
  let changeRow = change as unknown as Record<string, unknown>;
  const atRestKey = getActiveAtRestKey();
  if (atRestKey) {
    const [encItem, encChange] = await Promise.all([
      encryptRow('sharedItems', atRestKey, itemRow),
      encryptRow('changeLog', atRestKey, changeRow),
    ]);
    if (!encItem || !encChange) throw new Error('Failed to encrypt shared item');
    itemRow = encItem;
    changeRow = encChange;
  }

  await db.transaction('rw', [db.sharedItems, db.changeLog], async () => {
    await db.sharedItems.put(itemRow as unknown as SharedItem);
    await db.changeLog.add(changeRow as unknown as ChangeEntry);
  });
  scheduleSyncDebounced();
}

// Files and snippets are uploaded to the sync repository; without sync the
// upload failed with a generic "Failed to add shared file. Please try again."
// Says why instead. Returns true if the upload can go ahead.
async function checkCanUpload(): Promise<boolean> {
  const blocker = await sharedBlobBlocker().catch(() => 'not-ready' as const);
  if (blocker === 'no-sync') {
    toast('Files and text are stored in your sync repository: set up sync (or turn it back on) in Settings to add them.', 'error');
  } else if (blocker === 'not-ready') {
    toast('Sync is still starting — add it again in a moment.', 'info');
  }
  return blocker === null;
}

// Reject items that don't fit the remaining quota. Returns true if it fit.
/** Whether a file of `bytes` fits the Shared Folder now (no message). */
export async function sharedFolderHasRoomFor(bytes: number): Promise<boolean> {
  return bytes <= MAX_SHARED_FOLDER_BYTES - await currentUsedBytes();
}

async function checkFits(bytes: number): Promise<boolean> {
  const used = await currentUsedBytes();
  const remaining = MAX_SHARED_FOLDER_BYTES - used;
  if (bytes > remaining) {
    // Size rounded up, free space down: to the nearest 0.1 MB both could read
    // "30.0 MB" ("Item is 30.0 MB but only 30.0 MB is free").
    toast(
      `Item is ${formatBytes(bytes, 'up')} but only ${formatBytes(Math.max(0, remaining), 'down')} is free in the shared folder.`,
      'error',
    );
    return false;
  }
  return true;
}

async function nextOrder(): Promise<number> {
  return db.sharedItems.count();
}

/** A new item's expiry: added from a device in Paranoid Mode, it lasts PARANOID_SHARED_ITEM_TTL_MS. */
function expiryFields(createdAt: number): Pick<SharedItem, 'expiresAt'> {
  return isParanoidEnabled() ? { expiresAt: createdAt + PARANOID_SHARED_ITEM_TTL_MS } : {};
}

/** When `item` is deleted on its own (epoch ms), or undefined if never. Synced data: a non-number is no expiry. */
export function sharedItemExpiry(item: SharedItem): number | undefined {
  return Number.isFinite(item.expiresAt) && item.expiresAt! > 0 ? item.expiresAt : undefined;
}

// --- Create ---

export async function createLinkItem(url: string, title?: string): Promise<SharedItem | undefined> {
  try {
    const trimmed = url.trim();
    if (!isValidUrl(trimmed)) {
      toast('That doesn’t look like a valid http(s) URL.', 'error');
      return undefined;
    }
    const name = (title ?? '').trim() || trimmed;
    const size = new TextEncoder().encode(trimmed + name).length;
    if (!(await checkFits(size))) return undefined;

    const now = Date.now();
    const item: SharedItem = {
      id: newId(),
      type: 'link',
      name,
      size,
      url: trimmed,
      order: await nextOrder(),
      createdAt: now,
      updatedAt: now,
      ...expiryFields(now),
    };
    item.fieldTimestamps = initFieldTimestamps(item as unknown as Record<string, unknown>, now);
    await putSharedItem(item);
    return item;
  } catch (error) {
    handleDbError(error, 'create shared link');
    return undefined;
  }
}

export async function createFileItem(file: File): Promise<SharedItem | undefined> {
  try {
    if (!(await checkCanUpload())) return undefined;
    if (!(await checkFits(file.size))) return undefined;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const blobId = newId();
    // Upload bytes BEFORE persisting metadata: if upload fails we never record a
    // dangling item; a failure after upload leaves only a harmless orphan blob.
    // Both under the branch lock, so no compaction here sees the bytes unnamed.
    return await withBlobBranchLock(async () => {
      // Again under the lock, before the upload: the check above ran before an
      // upload that can take a minute, and two adds at once both passed it.
      if (!(await checkFits(bytes.length))) return undefined;
      await uploadSharedBlob(blobId, bytes);

      const now = Date.now();
      const item: SharedItem = {
        id: newId(),
        type: 'file',
        name: file.name || 'file',
        size: bytes.length,
        blobId,
        mimeType: file.type || 'application/octet-stream',
        order: await nextOrder(),
        createdAt: now,
        updatedAt: now,
        ...expiryFields(now),
      };
      item.fieldTimestamps = initFieldTimestamps(item as unknown as Record<string, unknown>, now);
      await putSharedItem(item);
      return item;
    });
  } catch (error) {
    handleDbError(error, 'add shared file');
    return undefined;
  }
}

export async function createSnippetItem(name: string, text: string): Promise<SharedItem | undefined> {
  try {
    if (!text.trim()) {
      toast('Nothing to save — the text is empty.', 'error');
      return undefined;
    }
    if (!(await checkCanUpload())) return undefined;
    const bytes = new TextEncoder().encode(text);
    if (!(await checkFits(bytes.length))) return undefined;
    const blobId = newId();
    return await withBlobBranchLock(async () => {
      if (!(await checkFits(bytes.length))) return undefined; // again, under the lock (see createFileItem)
      await uploadSharedBlob(blobId, bytes);

      const now = Date.now();
      const item: SharedItem = {
        id: newId(),
        type: 'snippet',
        name: name.trim() || 'Snippet',
        size: bytes.length,
        blobId,
        mimeType: 'text/plain',
        order: await nextOrder(),
        createdAt: now,
        updatedAt: now,
        ...expiryFields(now),
      };
      item.fieldTimestamps = initFieldTimestamps(item as unknown as Record<string, unknown>, now);
      await putSharedItem(item);
      return item;
    });
  } catch (error) {
    handleDbError(error, 'create shared snippet');
    return undefined;
  }
}

// --- Delete (soft) ---

export async function deleteSharedItem(id: string): Promise<void> {
  try {
    const existing = await db.sharedItems.get(id);
    if (!existing) return;
    const now = Date.now();
    const updated: SharedItem = {
      ...existing,
      deletedAt: now,
      updatedAt: now,
      fieldTimestamps: stampUpdatedFields(existing.fieldTimestamps, ['deletedAt'], now),
    };
    await putSharedItem(updated);
    // Local only: the bytes leave the backend with the compaction that follows
    // the next sync (one branch rewrite however many files are deleted).
    if (existing.blobId) await deleteSharedBlob(existing.blobId);
  } catch (error) {
    handleDbError(error, 'delete shared item');
  }
}

/**
 * Delete the items whose expiry has passed (added from a device in Paranoid
 * Mode) — on whichever device sees it first, bytes included, like a Delete.
 * Returns how many went.
 */
export async function expireSharedItems(now: number = Date.now()): Promise<number> {
  try {
    const expired = (await db.sharedItems.toArray()).filter((i) => {
      const expiry = sharedItemExpiry(i);
      return !i.deletedAt && expiry !== undefined && expiry <= now;
    });
    for (const item of expired) await deleteSharedItem(item.id);
    return expired.length;
  } catch (error) {
    handleDbError(error, 'expire shared items');
    return 0;
  }
}

// Fire just after the expiry, so the sweep finds it due.
const EXPIRY_SLACK_MS = 250;

/**
 * While the app is unlocked: delete the expired shared items now, and the next
 * one when its time comes. The query also re-runs when sync brings an item in
 * from another device, expired or not. A sweep that fails isn't retried every
 * minute: the next unlock or start runs it again.
 */
export function useSharedItemExpiry(): void {
  const nextExpiry = useLiveQuery(async () => {
    let soonest = 0;
    for (const item of await db.sharedItems.toArray()) {
      const expiry = item.deletedAt ? undefined : sharedItemExpiry(item);
      if (expiry !== undefined && (!soonest || expiry < soonest)) soonest = expiry;
    }
    return soonest;
  }, [], 0);
  // Browser timers stand still while the device sleeps (see the idle lock): one
  // armed before a night asleep would fire hours late. So the expiry is judged
  // on the wall clock again every minute and when the app comes back into view.
  const tick = useMinuteTick();
  const sweptFor = useRef(0);

  useEffect(() => {
    if (!nextExpiry || sweptFor.current === nextExpiry) return;
    const sweep = () => {
      if (Date.now() < nextExpiry) return; // the clock went back: the next tick judges again
      sweptFor.current = nextExpiry;
      void expireSharedItems();
    };
    const delay = nextExpiry - Date.now();
    if (delay <= 0) {
      sweep();
      return;
    }
    // Expiries are at most a day out: well inside setTimeout's ~24.8-day range.
    const timer = setTimeout(sweep, delay + EXPIRY_SLACK_MS);
    return () => clearTimeout(timer);
  }, [nextExpiry, tick]);
}

/**
 * Soft-delete every item currently in the folder. Deliberately loops over
 * deleteSharedItem rather than doing one bulk write, so tombstones, change-log
 * entries and blob cleanup behave exactly as for a single delete (a folder is
 * capped at 30MB, so the item count stays small). Returns how many were deleted;
 * a per-item failure is reported by deleteSharedItem and doesn't stop the rest.
 */
export async function deleteAllSharedItems(): Promise<number> {
  try {
    const live = (await db.sharedItems.toArray()).filter((i) => !i.deletedAt);
    for (const item of live) await deleteSharedItem(item.id);
    return live.length;
  } catch (error) {
    handleDbError(error, 'empty shared folder');
    return 0;
  }
}
