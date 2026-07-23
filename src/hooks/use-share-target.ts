import { useEffect, useRef } from 'react';
import { toast } from '../components/ui/Toast';
import { recordError } from '../lib/diagnostics';
import { useAppState } from '../stores/app-state';
import { createFileItem } from './use-shared-items';
import { canUploadSharedBlob } from '../sync/shared-blobs';
import { sanitize, formatCaptureResult, captureToInbox } from './use-url-capture';
import {
  SHARE_CACHE, SHARE_META_PATH, shareFilePath, SHARE_TARGET_FLAG, SHARE_STASH_TTL_MS, type SharedPayloadMeta,
} from '../lib/share-target';

const SHARED_FOLDER_LIST_ID = '__shared__';

// The consume runs at startup, often before the async initial sync has derived
// and cached the sync key — and saving a shared FILE uploads its blob through
// sync, so it can't run yet. Wait up to this long for sync to become ready
// before saving files; if it never does (offline), the stash is kept for the
// next unlocked start to retry rather than dropping the file.
const SYNC_READY_TIMEOUT_MS = 30_000;
const SYNC_READY_POLL_MS = 250;

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

/**
 * Consume a Web Share Target payload stashed by the service worker (see src/sw.ts).
 * Files are saved into the E2E-encrypted Shared Folder; shared links and plain text
 * become an Inbox task (the link stays clickable). Mounted in UnlockedApp, so for a
 * Paranoid device the stash simply waits in Cache Storage until the vault is unlocked
 * and this runs.
 *
 * Runs on EVERY unlocked start, not only on the ?shareTarget redirect: the stash is
 * plaintext, so an orphaned one (redirect lost — tab closed while locked, app next
 * opened from the launcher) must still be consumed if fresh or purged if older than
 * SHARE_STASH_TTL_MS, instead of lingering indefinitely (ACR-017).
 */
export function useShareTarget(): void {
  const handled = useRef(false);

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

        // Saving a file uploads its blob through sync, which may not be ready yet
        // at startup (key still deriving). Wait for it; if it never comes up
        // (offline), keep the stash and defer the WHOLE payload to the next start
        // so nothing is dropped — and so a mixed files+text share isn't half-saved.
        if ((meta.files?.length ?? 0) > 0 && !(await waitUntil(canUploadSharedBlob, SYNC_READY_TIMEOUT_MS, SYNC_READY_POLL_MS))) {
          keepStash = true;
          toast('Sync isn’t ready yet — your shared file will be saved next time you open the app online', 'info');
          return;
        }

        // 1) Files -> Shared Folder (reconstruct File objects from the cached blobs).
        let filesSaved = 0;
        for (let i = 0; i < (meta.files?.length ?? 0); i++) {
          const fileRes = await cache.match(shareFilePath(i));
          if (!fileRes) continue;
          const blob = await fileRes.blob();
          const f = meta.files[i];
          const file = new File([blob], f.name || `shared-${i}`, { type: f.type || blob.type || 'application/octet-stream' });
          const saved = await createFileItem(file); // enforces the Shared Folder quota + toasts on failure
          if (saved) filesSaved++;
        }

        // 2) Text / links -> Inbox task (same path as bookmarklet/manual capture, so
        //    the URL renders as a clickable link).
        const title = sanitize(meta.title);
        const url = sanitize(meta.url);
        const text = sanitize(meta.text);
        let inboxSaved = false;
        if (title || url || text) {
          const result = formatCaptureResult(title, url, text);
          if (result.title) { await captureToInbox(result); inboxSaved = true; }
        }

        if (filesSaved > 0) {
          // Surface the result where it landed.
          useAppState.getState().selectList(SHARED_FOLDER_LIST_ID);
          if (!inboxSaved) toast(`Saved ${filesSaved} file${filesSaved === 1 ? '' : 's'} to the Shared Folder`, 'success');
        } else if (!inboxSaved) {
          toast('Nothing to save from the share', 'info');
        }
        if (meta.skippedFiles) {
          toast(`${meta.skippedFiles} shared file${meta.skippedFiles === 1 ? ' was' : 's were'} too large to receive`, 'error');
        }
      } catch (err) {
        recordError('shareTarget.consume', err);
        toast('Could not save the shared content', 'error');
      } finally {
        // Keep the stash only when a file couldn't be saved because sync wasn't
        // ready — the next unlocked start (sync online) retries it. Its plaintext
        // lifetime stays bounded by SHARE_STASH_TTL_MS + the ACR-017 sweep.
        if (!keepStash) await clearStash();
        if (flag) cleanUrl();
      }
    })();
  }, []);
}
