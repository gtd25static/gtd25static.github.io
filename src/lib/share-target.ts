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
