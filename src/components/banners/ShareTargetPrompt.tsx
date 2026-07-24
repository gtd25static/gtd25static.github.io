import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { formatBytes } from '../../hooks/use-shared-items';
import type { ShareTargetApi } from '../../hooks/use-share-target';

// Destination prompt for content shared into the app (Android share sheet →
// Web Share Target). Closing the dialog without choosing (Esc, backdrop, ✕)
// postpones: the share is kept and offered again on the next start.
export function ShareTargetPrompt({ pendingShare, resolveShare, discardShare, postponeShare }: ShareTargetApi) {
  if (!pendingShare) return null;
  const { files, title, url, text } = pendingShare;
  const preview = [title, url, text].filter(Boolean).join(' — ');
  const hasFiles = files.length > 0;

  return (
    <Modal open onClose={postponeShare} title="Save shared content">
      <div className="space-y-4">
        {hasFiles && (
          <ul className="max-h-32 space-y-1 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-700 dark:bg-zinc-800/60">
            {files.map((f, i) => (
              <li key={i} className="truncate text-sm text-zinc-700 dark:text-zinc-200">
                {f.name} <span className="text-xs text-zinc-400">({formatBytes(f.size)})</span>
              </li>
            ))}
          </ul>
        )}
        {preview && (
          <p className="line-clamp-3 break-words rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300">
            {preview}
          </p>
        )}
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Where should this go?
          {hasFiles && (
            <span className="mt-1 block text-xs text-zinc-400 dark:text-zinc-500">
              Files always keep their bytes in the Shared Folder — “Add to Inbox” also creates a task pointing at each file.
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={discardShare}
            className="mr-auto rounded-lg px-3 py-1.5 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
          >
            Discard
          </button>
          {/* The likelier destination gets the primary style: folder for files,
              inbox for a shared link/text (the old automatic routing). */}
          <Button size="sm" variant={hasFiles ? 'secondary' : 'primary'} onClick={() => resolveShare('inbox')}>
            Add to Inbox
          </Button>
          <Button size="sm" variant={hasFiles ? 'primary' : 'secondary'} onClick={() => resolveShare('shared-folder')}>
            Save to Shared Folder
          </Button>
        </div>
      </div>
    </Modal>
  );
}
