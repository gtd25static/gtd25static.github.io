// Web Share Target plumbing shared between the service worker and the client.
//
// Receiving FILES from the OS share sheet requires a POST/multipart share target
// (a GET target can only carry title/text/url). The browser POSTs the shared
// payload to the SW, which can't touch the app's (Dexie/encrypted) store directly,
// so it stashes the payload in Cache Storage and redirects the app to consume it.
// The client hook (use-share-target) then routes files into the E2E-encrypted
// Shared Folder and text/links into the Inbox, and clears the stash.

import { MAX_SHARED_FOLDER_BYTES } from './constants';

export const SHARE_CACHE = 'gtd25-share-v1';
export const SHARE_TARGET_ACTION = '/share-target';
export const SHARE_META_PATH = '/__gtd25-share/meta';
export const shareFilePath = (i: number): string => `/__gtd25-share/file/${i}`;
export const SHARE_TARGET_FLAG = 'shareTarget'; // ?shareTarget=1 (or =error)

// The stash holds shared content in PLAINTEXT until the app consumes it, so its
// lifetime must be bounded: anything older than this is purged unconsumed by the
// startup sweep in use-share-target (ACR-017).
export const SHARE_STASH_TTL_MS = 24 * 60 * 60 * 1000;

// Caps applied by the SW BEFORE stashing (ACR-018). The Shared Folder quota
// (createFileItem) stays the authoritative check at consume time; these only stop
// a mis-share from filling the origin's storage quota with bytes the app would
// reject anyway, so they mirror that quota.
export const MAX_SHARE_FILES = 20;
export const MAX_SHARE_FILE_BYTES = MAX_SHARED_FOLDER_BYTES;
export const MAX_SHARE_TOTAL_BYTES = MAX_SHARED_FOLDER_BYTES;

export interface SharedFileMeta { name: string; type: string; size: number }
export interface SharedPayloadMeta {
  title: string;
  text: string;
  url: string;
  ts: number;
  files: SharedFileMeta[];
  /** Files the SW refused to stash because of the ACR-018 caps. */
  skippedFiles?: number;
}

/**
 * Is a fresh (unexpired) share payload waiting in the stash?
 *
 * Reads the stash's TIMESTAMP ONLY — never its title/text/url/filenames — so it
 * is safe to call while the vault is locked, where the lock screen uses it to say
 * "a share is waiting" without rendering any shared content (ACR-017).
 */
export async function hasFreshShareStash(): Promise<boolean> {
  try {
    // has() first: open() would CREATE the cache on a device that never received
    // a share, leaving an empty shell behind.
    if (typeof caches === 'undefined' || !(await caches.has(SHARE_CACHE))) return false;
    const cache = await caches.open(SHARE_CACHE);
    const metaRes = await cache.match(SHARE_META_PATH);
    if (!metaRes) return false;
    const meta = (await metaRes.json()) as SharedPayloadMeta;
    return typeof meta?.ts === 'number' && Date.now() - meta.ts <= SHARE_STASH_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Delete the stash once it is past its TTL, wherever we are.
 *
 * The 24h bound (ACR-017) used to be enforced only by the sweep in
 * use-share-target, which mounts UNLOCKED — so on a Paranoid device that was
 * never unlocked again, the plaintext bytes stayed in Cache Storage forever, and
 * after 24h the lock screen stopped even mentioning them. This needs no vault
 * key (it reads a timestamp and deletes), so the lock screen runs it too.
 * Returns true when something was purged.
 */
export async function purgeExpiredShareStash(): Promise<boolean> {
  try {
    if (typeof caches === 'undefined' || !(await caches.has(SHARE_CACHE))) return false;
    const cache = await caches.open(SHARE_CACHE);
    const metaRes = await cache.match(SHARE_META_PATH);
    // No meta at all means a partial/abandoned stash — also worth dropping.
    const expired = !metaRes || await (async () => {
      const meta = (await metaRes.json()) as SharedPayloadMeta;
      return typeof meta?.ts !== 'number' || Date.now() - meta.ts > SHARE_STASH_TTL_MS;
    })();
    if (!expired) return false;
    await caches.delete(SHARE_CACHE);
    return true;
  } catch {
    return false; // storage unavailable — the unlocked sweep still gets another go
  }
}

/**
 * Pick which shared files fit the stash caps, preserving share order. Returns the
 * files to stash and how many were skipped (surfaced to the user after consume).
 */
export function selectFilesToStash<T extends { size: number }>(all: T[]): { keep: T[]; skipped: number } {
  const keep: T[] = [];
  let total = 0;
  for (const f of all) {
    if (keep.length >= MAX_SHARE_FILES || f.size > MAX_SHARE_FILE_BYTES || total + f.size > MAX_SHARE_TOTAL_BYTES) continue;
    keep.push(f);
    total += f.size;
  }
  return { keep, skipped: all.length - keep.length };
}
