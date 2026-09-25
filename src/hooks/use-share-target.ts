import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from '../components/ui/Toast';
import { recordError } from '../lib/diagnostics';
import { useAppState } from '../stores/app-state';
import { createFileItem, createLinkItem, createSnippetItem } from './use-shared-items';
import { canUploadSharedBlob } from '../sync/shared-blobs';
import { createTask } from './use-tasks';
import { getOrCreateInbox } from './use-task-lists';
import { extractUrl } from '../lib/link-utils';
import { sanitize, formatCaptureResult, captureToInbox } from './use-url-capture';
import {
  SHARE_CACHE, SHARE_META_PATH, shareFilePath, SHARE_TARGET_FLAG, SHARE_STASH_TTL_MS, type SharedPayloadMeta,
} from '../lib/share-target';

const SHARED_FOLDER_LIST_ID = '__shared__';

// The consume runs at startup, often before the async initial sync has derived
// and cached the sync key — and saving a shared FILE uploads its blob through
// sync, so it can't run yet. Wait up to this long for sync to become ready
// before offering to save files; if it never does (offline), the stash is kept
// for the next unlocked start to retry rather than dropping the file.
const SYNC_READY_TIMEOUT_MS = 30_000;
const SYNC_READY_POLL_MS = 250;

/** Where the user chose to file a share. */
export type ShareDestination = 'inbox' | 'shared-folder';

export interface PendingShare {
  /** Files reconstructed from the stashed blobs. */
  files: File[];
  title: string;
  url: string;
  text: string;
}

export interface ShareTargetApi {
  /** A consumed share awaiting the user's destination choice; null otherwise. */
  pendingShare: PendingShare | null;
  /** Save the pending share to the chosen destination and clear the stash. */
  resolveShare: (dest: ShareDestination) => void;
  /** Drop the pending share entirely (stash cleared, nothing saved). */
  discardShare: () => void;
  /** Close the prompt but keep the stash — asked again on the next start. */
  postponeShare: () => void;
}

/** Resolve once `check()` is true, or false if `timeoutMs` elapses first. */
async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Best-effort wipe of the stashed share payload (and metadata) from Cache Storage. */
async function clearStash(): Promise<void> {
  try { await caches.delete(SHARE_CACHE); } catch { /* nothing to clear */ }
}

function cleanUrl(): void {
  try { window.history.replaceState(null, '', '/'); } catch { /* no-op */ }
}

/** Files → Shared Folder items; a link/text → a link or snippet item. */
async function saveToSharedFolder({ files, title, url, text }: PendingShare): Promise<number> {
  let saved = 0;
  for (const file of files) {
    if (await createFileItem(file)) saved++; // enforces the quota + toasts on failure
  }
  const link = url || extractUrl(text);
  if (link) {
    if (await createLinkItem(link, title || undefined)) saved++;
  } else if (text || title) {
    if (await createSnippetItem(title || text.slice(0, 60), text || title)) saved++;
  }
  return saved;
}

/**
 * Text/link → an Inbox task (same path as the bookmarklet, so the URL renders
 * clickable). Files can't live inside a task, so each is saved to the Shared
 * Folder AND gets an Inbox task whose description points at it — the inbox
 * entry to process, with the bytes kept where files belong.
 */
async function saveToInbox({ files, title, url, text }: PendingShare): Promise<{ filesSaved: number; tasksCreated: number }> {
  let filesSaved = 0;
  let tasksCreated = 0;
  const result = formatCaptureResult(title, url, text);
  if (result.title) {
    await captureToInbox(result); // toasts 'Captured to Inbox' itself
    tasksCreated++;
  }
  if (files.length > 0) {
    const inboxId = await getOrCreateInbox();
    for (const file of files) {
      if (!(await createFileItem(file))) continue;
      filesSaved++;
      const task = await createTask(inboxId, {
        title: file.name,
        description: 'Attached file — saved in the Shared Folder',
      });
      if (task) tasksCreated++;
    }
  }
  return { filesSaved, tasksCreated };
}

/**
 * Consume a Web Share Target payload stashed by the service worker (see src/sw.ts)
 * and ask the user where to file it: an Inbox task, or the E2E-encrypted Shared
 * Folder (files always store their bytes there — choosing Inbox adds a task that
 * points at each file). Mounted in UnlockedApp, so for a Paranoid device the stash
 * simply waits in Cache Storage until the vault is unlocked and this runs.
 *
 * Runs on EVERY unlocked start, not only on the ?shareTarget redirect: the stash is
 * plaintext, so an orphaned one (redirect lost — tab closed while locked, app next
 * opened from the launcher) must still be offered if fresh or purged if older than
 * SHARE_STASH_TTL_MS, instead of lingering indefinitely (ACR-017). An unanswered
 * prompt keeps the stash for the next start — still inside the same TTL bound.
 */
export function useShareTarget(): ShareTargetApi {
  const handled = useRef(false);
  const [pendingShare, setPendingShare] = useState<PendingShare | null>(null);
  // The share being asked about, readable from the callbacks without a state
  // updater (StrictMode replays updaters, which saved a share twice) and taken
  // synchronously so a double tap can't save it twice either.
  const pendingRef = useRef<PendingShare | null>(null);
  const showPending = useCallback((share: PendingShare | null) => {
    pendingRef.current = share;
    setPendingShare(share);
  }, []);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const params = new URLSearchParams(window.location.search);
    const flag = params.get(SHARE_TARGET_FLAG);

    void (async () => {
      if (typeof caches === 'undefined') {
        if (flag) { toast('Could not read the shared content', 'error'); cleanUrl(); }
        return;
      }
      // The SW redirects with ?shareTarget=error when it couldn't read the POST body.
      // Its stash may be PARTIAL (meta written before a file put failed) — clear it.
      if (flag === 'error') {
        toast('Could not read the shared content', 'error');
        await clearStash();
        cleanUrl();
        return;
      }
      let keepStash = false;
      try {
        // Cheap existence probe first: on a normal launch with nothing stashed this
        // must not caches.open() (which CREATES the cache) only for the finally to
        // delete it again. Early returns below rely on the finally for cleanup.
        if (!(await caches.has(SHARE_CACHE))) return;
        const cache = await caches.open(SHARE_CACHE);
        const metaRes = await cache.match(SHARE_META_PATH);
        if (!metaRes) return; // empty stash shell (e.g. reload of the URL)
        const meta = (await metaRes.json()) as SharedPayloadMeta;

        // Stale orphaned stash: discard without importing (the share is long past;
        // silently resurrecting day-old content would be surprising).
        if (typeof meta?.ts !== 'number' || Date.now() - meta.ts > SHARE_STASH_TTL_MS) return;

        const title = sanitize(meta.title);
        const url = sanitize(meta.url);
        const text = sanitize(meta.text);

        // Files store their bytes through sync whichever destination is picked,
        // and can't save before sync is ready, which at startup it may not be
        // (key still deriving). Wait for it; if it never comes up (offline), keep
        // the stash and defer the WHOLE payload to the next start so nothing is
        // dropped — and so a mixed share isn't half-saved. Link and text shares
        // prompt immediately: as an Inbox task they need no sync (text headed for
        // the Shared Folder is checked when that destination is picked).
        const needsBlobUpload = (meta.files?.length ?? 0) > 0;
        if (needsBlobUpload && !(await waitUntil(canUploadSharedBlob, SYNC_READY_TIMEOUT_MS, SYNC_READY_POLL_MS))) {
          keepStash = true;
          toast('Sync isn’t ready yet — your shared content will be saved next time you open the app online', 'info');
          return;
        }

        // Reconstruct File objects from the cached blobs.
        const files: File[] = [];
        for (let i = 0; i < (meta.files?.length ?? 0); i++) {
          const fileRes = await cache.match(shareFilePath(i));
          if (!fileRes) continue;
          const blob = await fileRes.blob();
          const f = meta.files[i];
          files.push(new File([blob], f.name || `shared-${i}`, { type: f.type || blob.type || 'application/octet-stream' }));
        }

        if (files.length === 0 && !title && !url && !text) {
          toast('Nothing to save from the share', 'info');
          return;
        }
        if (meta.skippedFiles) {
          toast(`${meta.skippedFiles} shared file${meta.skippedFiles === 1 ? ' was' : 's were'} too large to receive`, 'error');
        }

        // Hand over to the destination prompt. The stash stays until the user
        // answers (resolve/discard clear it; postpone/app-close keep it for the
        // next start, still bounded by SHARE_STASH_TTL_MS + the ACR-017 sweep).
        keepStash = true;
        showPending({ files, title, url, text });
      } catch (err) {
        recordError('shareTarget.consume', err);
        toast('Could not save the shared content', 'error');
      } finally {
        if (!keepStash) await clearStash();
        if (flag) cleanUrl();
      }
    })();
  }, [showPending]);

  const resolveShare = useCallback((dest: ShareDestination) => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null; // taken: a second tap is a no-op
    void (async () => {
      // Text with no link becomes a snippet in the Shared Folder, which stores
      // its bytes through sync. Without sync, keep asking (Inbox still works)
      // and keep the stash rather than lose the text.
      const snippetOnly = pending.files.length === 0 && !pending.url && !extractUrl(pending.text);
      if (dest === 'shared-folder' && snippetOnly && !(await canUploadSharedBlob().catch(() => false))) {
        pendingRef.current = pending;
        toast('The Shared Folder needs sync — add it to the Inbox, or try again once sync is set up', 'info');
        return;
      }
      setPendingShare(null);
      try {
        if (dest === 'shared-folder') {
          const saved = await saveToSharedFolder(pending);
          if (saved > 0) {
            useAppState.getState().selectList(SHARED_FOLDER_LIST_ID);
            toast(`Saved ${saved} item${saved === 1 ? '' : 's'} to the Shared Folder`, 'success');
          }
        } else {
          const { filesSaved } = await saveToInbox(pending);
          if (filesSaved > 0) {
            toast(`Saved ${filesSaved} file${filesSaved === 1 ? '' : 's'} to the Shared Folder and added ${filesSaved === 1 ? 'an Inbox task' : 'Inbox tasks'}`, 'success');
          }
        }
      } catch (err) {
        recordError('shareTarget.save', err);
        toast('Could not save the shared content', 'error');
      } finally {
        await clearStash();
      }
    })();
  }, []);

  const discardShare = useCallback(() => {
    showPending(null);
    void clearStash();
    toast('Share discarded', 'info');
  }, [showPending]);

  const postponeShare = useCallback(() => {
    // Stash intentionally kept: the prompt returns on the next unlocked start
    // (or is purged unconsumed once older than SHARE_STASH_TTL_MS).
    showPending(null);
    toast('Share kept — you’ll be asked again next time the app opens', 'info');
  }, [showPending]);

  return { pendingShare, resolveShare, discardShare, postponeShare };
}
