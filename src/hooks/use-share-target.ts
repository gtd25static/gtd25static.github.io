import { useEffect, useRef } from 'react';
import { toast } from '../components/ui/Toast';
import { recordError } from '../lib/diagnostics';
import { useAppState } from '../stores/app-state';
import { createFileItem } from './use-shared-items';
import { sanitize, formatCaptureResult, captureToInbox } from './use-url-capture';
import {
  SHARE_CACHE, SHARE_META_PATH, shareFilePath, SHARE_TARGET_FLAG, type SharedPayloadMeta,
} from '../lib/share-target';

const SHARED_FOLDER_LIST_ID = '__shared__';

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
 */
export function useShareTarget(): void {
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    const params = new URLSearchParams(window.location.search);
    const flag = params.get(SHARE_TARGET_FLAG);
    if (!flag) return;
    handled.current = true;

    void (async () => {
      // The SW redirects with ?shareTarget=error when it couldn't read the POST body.
      if (flag === 'error' || typeof caches === 'undefined') {
        toast('Could not read the shared content', 'error');
        cleanUrl();
        return;
      }
      try {
        const cache = await caches.open(SHARE_CACHE);
        const metaRes = await cache.match(SHARE_META_PATH);
        if (!metaRes) { cleanUrl(); return; } // nothing stashed (e.g. reload of the URL)
        const meta = (await metaRes.json()) as SharedPayloadMeta;

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
      } catch (err) {
        recordError('shareTarget.consume', err);
        toast('Could not save the shared content', 'error');
      } finally {
        await clearStash();
        cleanUrl();
      }
    })();
  }, []);
}
