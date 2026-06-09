// Web Share Target plumbing shared between the service worker and the client.
//
// Receiving FILES from the OS share sheet requires a POST/multipart share target
// (a GET target can only carry title/text/url). The browser POSTs the shared
// payload to the SW, which can't touch the app's (Dexie/encrypted) store directly,
// so it stashes the payload in Cache Storage and redirects the app to consume it.
// The client hook (use-share-target) then routes files into the E2E-encrypted
// Shared Folder and text/links into the Inbox, and clears the stash.

export const SHARE_CACHE = 'gtd25-share-v1';
export const SHARE_TARGET_ACTION = '/share-target';
export const SHARE_META_PATH = '/__gtd25-share/meta';
export const shareFilePath = (i: number): string => `/__gtd25-share/file/${i}`;
export const SHARE_TARGET_FLAG = 'shareTarget'; // ?shareTarget=1 (or =error)

export interface SharedFileMeta { name: string; type: string; size: number }
export interface SharedPayloadMeta {
  title: string;
  text: string;
  url: string;
  ts: number;
  files: SharedFileMeta[];
}
