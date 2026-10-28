import { useState } from 'react';
import type { SharedItem } from '../../db/models';
import {
  formatBytes,
  deleteSharedItem,
  createdTime,
  paranoidExpiry,
  sharedItemExpiry,
  sharedItemOpacity,
} from '../../hooks/use-shared-items';
import { PARANOID_SHARED_ITEM_TTL_MS } from '../../lib/constants';
import { useMinuteTick } from '../../hooks/use-minute-tick';
import { getSharedBlobBytes } from '../../sync/shared-blobs';
import { extractHostname, sanitizeUrl } from '../../lib/link-utils';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/ConfirmDialog';
import { SharedImagePreview } from './SharedImagePreview';
import { SharedTextPreview } from './SharedTextPreview';
import { loadSnippetText, snippetErrorMessage } from './snippet-text';
import { createSessionObjectUrl } from '../../lib/session-object-urls';
import { writeTextWithHygiene } from '../../lib/clipboard-hygiene';

// Common MIME → extension fallbacks, used only when the stored name lacks one
// (e.g. snippets named "notes", or a file dropped without an extension).
const MIME_EXT: Record<string, string> = {
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

// The filename a download should use: the original name, with an extension
// inferred from the MIME type appended if the name doesn't already have one.
export function downloadName(item: SharedItem): string {
  const name = item.name?.trim() || 'download';
  const hasExt = /\.[^./\\]+$/.test(name); // a dot followed by a non-empty, non-dot tail
  if (hasExt) return name;
  const ext = item.mimeType ? MIME_EXT[item.mimeType] : undefined;
  return ext ? `${name}.${ext}` : name;
}

function TypeIcon({ type }: { type: SharedItem['type'] }) {
  const cls = 'shrink-0 text-zinc-400';
  if (type === 'link') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M10 13a5 5 0 007.07 0l3-3a5 5 0 00-7.07-7.07l-1.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 11a5 5 0 00-7.07 0l-3 3a5 5 0 007.07 7.07l1.5-1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (type === 'snippet') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" strokeLinejoin="round" />
      <path d="M14 2v6h6" strokeLinejoin="round" />
    </svg>
  );
}

// When an item was added, in the browser's language: "28 Oct, 14:05" on the
// card (no year: nothing stays a month), with the year in its tooltip.
function formatAdded(ts: number, withYear = false): string {
  return new Date(ts).toLocaleString(undefined, {
    year: withYear ? 'numeric' : undefined,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Time left before an expiring item goes: minutes in its last hour, else whole hours. */
function timeLeft(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

/** The mark on an item added from a device in Paranoid Mode: when it will be deleted. */
function ExpiryBadge({ expiresAt }: { expiresAt: number }) {
  useMinuteTick(); // the countdown moves on its own
  const left = expiresAt - Date.now();
  const soon = left < 60 * 60 * 1000;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        soon
          ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
          : 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      }`}
      title={`Added from a device in Paranoid Mode: deleted from every device ${PARANOID_SHARED_ITEM_TTL_MS / 3_600_000} hours after it was added`}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {left > 0 ? `Deletes in ${timeLeft(left)}` : 'Deleting…'}
    </span>
  );
}

/** The mark on an item this device hasn't uploaded yet; it goes once a sync has. */
function PendingSyncIcon() {
  return (
    <span
      role="img"
      aria-label="Not synced yet"
      title="Not synced yet: it reaches your other devices with the next sync"
      className="inline-flex shrink-0 items-center"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        <path d="M7 18a4.5 4.5 0 01-.6-8.96A6 6 0 0118 9a4 4 0 01-.5 9" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 20v-7m0 0l-2.5 2.5M12 13l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** `pending`: this device has a change to it not yet uploaded (see usePendingSharedItemIds). */
export function SharedItemCard({ item, pending = false }: { item: SharedItem; pending?: boolean }) {
  useMinuteTick(); // the fade deepens on its own
  const expiresAt = paranoidExpiry(item);
  const created = createdTime(item);
  const deletes = sharedItemExpiry(item);
  // Its last days before the 30-day rule deletes it, the card fades into the page.
  const opacity = sharedItemOpacity(item);
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Images and text snippets preview in an overlay on click (Copy/Download from
  // there); every other file type keeps the direct download. Not SVG: it is a
  // document that can carry script, and the preview's blob: URL opened in a tab
  // ("Open image in new tab") would render it in this app's origin.
  const isImage = item.type === 'file' && !!item.mimeType?.startsWith('image/') && !item.mimeType.includes('svg');
  const isSnippet = item.type === 'snippet';
  const previews = isImage || isSnippet;

  async function download() {
    if (!item.blobId) return;
    setBusy(true);
    try {
      const bytes = await getSharedBlobBytes(item.blobId, item.size);
      // Copy into a fresh ArrayBuffer so the Blob owns a clean, correctly-sized buffer.
      const buf = bytes.slice().buffer;
      // Always opaque bytes: the type is whatever the uploader's file said, and a
      // blob: URL of type text/html or image/svg+xml opened in a tab renders as a
      // document in this app's origin. The download attribute names the file.
      const blob = new Blob([buf], { type: 'application/octet-stream' });
      // Tracked so a lock revokes it: the minute-long grace below kept decrypted
      // file bytes resolvable at a same-origin blob: URL after the DEK was gone.
      const url = createSessionObjectUrl(blob, 60_000);
      // The download attribute is what gives the saved file its real name+extension
      // (a blob: URL alone would save as a random UUID with no extension).
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName(item);
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      const msg = err instanceof Error && err.message === 'NO_SYNC_KEY'
        ? 'Unlock the vault / set up sync to open this item.'
        : 'Could not load this item.';
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  // A snippet copies straight from its card, without opening it.
  async function copySnippet() {
    setBusy(true);
    let text: string;
    try {
      text = await loadSnippetText(item);
    } catch (err) {
      toast(snippetErrorMessage(err), 'error');
      return;
    } finally {
      setBusy(false);
    }
    try {
      await writeTextWithHygiene(text);
      toast('Text copied', 'success');
    } catch {
      toast('Could not copy the text', 'error');
    }
  }

  async function handleDelete() {
    if (!await confirmDialog(`Delete “${item.name}” from the shared folder?`, { confirmLabel: 'Delete' })) return;
    await deleteSharedItem(item.id);
  }

  return (
    <div
      data-redact
      className="group flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-800/50"
      style={opacity < 1 ? { opacity } : undefined}
    >
      <TypeIcon type={item.type} />
      <div className="min-w-0 flex-1">
        {item.type === 'link' && item.url ? (
          <a
            href={sanitizeUrl(item.url)}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-sm font-medium text-accent-600 hover:underline dark:text-accent-400"
            title={item.url}
          >
            {item.name}
          </a>
        ) : (
          <button
            onClick={() => { if (previews) setPreviewOpen(true); else void download(); }}
            disabled={busy}
            className="block max-w-full truncate text-left text-sm font-medium text-zinc-800 hover:underline disabled:opacity-50 dark:text-zinc-100"
            title={previews ? `Preview ${item.name}` : `Download ${downloadName(item)}`}
          >
            {item.name}
          </button>
        )}
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
          {created > 0 && (
            <span
              className="shrink-0 tabular-nums"
              title={`Added ${formatAdded(created, true)}${deletes !== undefined ? ` — deleted from every device on ${formatAdded(deletes, true)}` : ''}`}
            >
              {formatAdded(created)}
            </span>
          )}
          {pending && <PendingSyncIcon />}
          <span className="min-w-0 truncate">
            {item.type === 'link' && item.url
              ? extractHostname(item.url)
              : `${item.type === 'snippet' ? 'Text' : (item.mimeType || 'File')} · ${formatBytes(item.size)}`}
          </span>
          {expiresAt !== undefined && <ExpiryBadge expiresAt={expiresAt} />}
        </div>
      </div>

      {/* Actions: phones have no hover, so they stay visible there (44px tap
          targets); on md+ they keep the reveal-on-hover treatment. */}
      <div className="flex shrink-0 items-center gap-1 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
        {isSnippet && (
          <button
            onClick={() => void copySnippet()}
            disabled={busy}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-50 md:min-h-0 md:min-w-0 md:p-1.5 dark:hover:bg-zinc-700"
            aria-label="Copy text"
            title="Copy text"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="9" y="9" width="12" height="12" rx="2" strokeLinejoin="round" />
              <path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {item.type !== 'link' && (
          <button
            onClick={download}
            disabled={busy}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-50 md:min-h-0 md:min-w-0 md:p-1.5 dark:hover:bg-zinc-700"
            aria-label="Download"
            title="Download"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <button
          onClick={handleDelete}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-zinc-400 hover:bg-red-50 hover:text-red-600 md:min-h-0 md:min-w-0 md:p-1.5 dark:hover:bg-red-900/20"
          aria-label="Delete"
          title="Delete"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {busy && (
        <svg className="h-4 w-4 animate-spin text-accent-500" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
          <path d="M12 2a10 10 0 0110 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      )}
      {previewOpen && isImage && (
        <SharedImagePreview item={item} filename={downloadName(item)} onClose={() => setPreviewOpen(false)} />
      )}
      {previewOpen && isSnippet && (
        <SharedTextPreview item={item} onDownload={() => void download()} onClose={() => setPreviewOpen(false)} />
      )}
    </div>
  );
}
