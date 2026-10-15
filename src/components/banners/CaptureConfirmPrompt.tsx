import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useCaptureConfirm } from '../../hooks/use-url-capture';

// Paranoid Mode: a captured page asks before it goes into the Inbox (see
// useCaptureConfirm). Closing the dialog (Esc, backdrop, ✕) discards — the page
// is still open in the browser, so a wanted capture is one click away. Nothing
// takes the focus on purpose: the window can jump to the front mid-typing, and
// a stray Enter must not file anything.
export function CaptureConfirmPrompt() {
  const { capture, count, add, discard } = useCaptureConfirm();
  if (!capture) return null;
  const { title, link, description } = capture;

  return (
    <Modal open onClose={discard} title={count > 1 ? `Add to Inbox? (1 of ${count})` : 'Add to Inbox?'}>
      <div className="space-y-4">
        <div data-redact className="space-y-1 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-700 dark:bg-zinc-800/60">
          <p className="line-clamp-3 break-words text-sm font-medium text-zinc-700 dark:text-zinc-200">{title}</p>
          {link && link !== title && <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{link}</p>}
          {description && <p className="line-clamp-2 break-words text-xs text-zinc-500 dark:text-zinc-400">{description}</p>}
        </div>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Keep it only if you just captured it — any website you click a link on can send a capture here.
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={discard}
            className="mr-auto rounded-lg px-3 py-1.5 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
          >
            Discard
          </button>
          <Button size="sm" variant="primary" onClick={add}>
            Add to Inbox
          </Button>
        </div>
      </div>
    </Modal>
  );
}
