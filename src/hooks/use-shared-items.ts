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
import { uploadSharedBlob, deleteSharedBlob } from '../sync/shared-blobs';
import { MAX_SHARED_FOLDER_BYTES } from '../lib/constants';
import { isValidUrl } from '../lib/link-utils';
import { toast } from '../components/ui/Toast';

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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

// Reject items that don't fit the remaining quota. Returns true if it fit.
async function checkFits(bytes: number): Promise<boolean> {
  const used = await currentUsedBytes();
  const remaining = MAX_SHARED_FOLDER_BYTES - used;
  if (bytes > remaining) {
    toast(
      `Item is ${formatBytes(bytes)} but only ${formatBytes(Math.max(0, remaining))} is free in the shared folder.`,
      'error',
    );
    return false;
  }
  return true;
}

async function nextOrder(): Promise<number> {
  return db.sharedItems.count();
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
    if (!(await checkFits(file.size))) return undefined;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const blobId = newId();
    // Upload bytes BEFORE persisting metadata: if upload fails we never record a
    // dangling item; a failure after upload leaves only a harmless orphan blob.
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
    };
    item.fieldTimestamps = initFieldTimestamps(item as unknown as Record<string, unknown>, now);
    await putSharedItem(item);
    return item;
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
    const bytes = new TextEncoder().encode(text);
    if (!(await checkFits(bytes.length))) return undefined;
    const blobId = newId();
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
    };
    item.fieldTimestamps = initFieldTimestamps(item as unknown as Record<string, unknown>, now);
    await putSharedItem(item);
    return item;
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
    // Best-effort immediate blob removal so backend space is reclaimed promptly;
    // purge also sweeps any that fail here. Metadata tombstone still syncs.
    if (existing.blobId) void deleteSharedBlob(existing.blobId);
  } catch (error) {
    handleDbError(error, 'delete shared item');
  }
}
