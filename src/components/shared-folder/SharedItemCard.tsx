import { useState } from 'react';
import type { SharedItem } from '../../db/models';
import { formatBytes, deleteSharedItem } from '../../hooks/use-shared-items';
import { getSharedBlobBytes } from '../../sync/shared-blobs';
import { extractHostname, sanitizeUrl } from '../../lib/link-utils';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/ConfirmDialog';

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

export function SharedItemCard({ item }: { item: SharedItem }) {
  const [busy, setBusy] = useState(false);

  async function openBlob(mode: 'open' | 'download') {
    if (!item.blobId) return;
    setBusy(true);
    try {
      const bytes = await getSharedBlobBytes(item.blobId);
      // Copy into a fresh ArrayBuffer so the Blob owns a clean, correctly-sized buffer.
      const buf = bytes.slice().buffer;
      const blob = new Blob([buf], { type: item.mimeType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      if (mode === 'download') {
        const a = document.createElement('a');
        a.href = url;
        a.download = item.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        window.open(url, '_blank', 'noopener');
      }
      // Revoke after a tick so the open/download has grabbed it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      const msg = err instanceof Error && err.message === 'NO_SYNC_KEY'
        ? 'Unlock the vault / set up sync to open this item.'
        : 'Could not load this item.';
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!await confirmDialog(`Delete “${item.name}” from the shared folder?`, { confirmLabel: 'Delete' })) return;
    await deleteSharedItem(item.id);
  }

  return (
    <div className="group flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-800/50">
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
            onClick={() => openBlob('open')}
            disabled={busy}
            className="block max-w-full truncate text-left text-sm font-medium text-zinc-800 hover:underline disabled:opacity-50 dark:text-zinc-100"
            title={item.name}
          >
            {item.name}
          </button>
        )}
        <div className="mt-0.5 truncate text-xs text-zinc-400">
          {item.type === 'link' && item.url
            ? extractHostname(item.url)
            : `${item.type === 'snippet' ? 'Text' : (item.mimeType || 'File')} · ${formatBytes(item.size)}`}
        </div>
      </div>

      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {item.type !== 'link' && (
          <button
            onClick={() => openBlob('download')}
            disabled={busy}
            className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-50 dark:hover:bg-zinc-700"
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
          className="rounded-full p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
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
    </div>
  );
}
