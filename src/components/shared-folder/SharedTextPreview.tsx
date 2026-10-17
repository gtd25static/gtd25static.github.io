import { useEffect, useState } from 'react';
import type { SharedItem } from '../../db/models';
import { writeTextWithHygiene } from '../../lib/clipboard-hygiene';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { loadSnippetText, snippetErrorMessage, SNIPPET_PREVIEW_CHARS } from './snippet-text';

// Overlay preview for a text snippet: the decrypted text shown inline — as a
// text node, never markup — with Copy (through the clipboard-hygiene wrapper,
// so the Paranoid auto-clear applies) and Download.
export function SharedTextPreview({ item, onDownload, onClose }: {
  item: SharedItem;
  onDownload: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await loadSnippetText(item);
        if (active) setText(loaded);
      } catch (err) {
        toast(snippetErrorMessage(err), 'error');
        if (active) onClose();
      }
    })();
    return () => { active = false; };
    // Reload only if the item itself changes — onClose identity is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.blobId]);

  async function copy() {
    if (text === null) return;
    try {
      await writeTextWithHygiene(text);
      toast('Text copied', 'success');
    } catch {
      toast('Could not copy the text', 'error');
    }
  }

  const truncated = text !== null && text.length > SNIPPET_PREVIEW_CHARS;

  return (
    // The name is content, and the Modal header renders outside the redact
    // wrapper below — so it stays generic and the name is shown in the body.
    <Modal open onClose={onClose} title="Text preview">
      <div className="space-y-4" data-redact>
        <p className="truncate text-sm font-medium text-zinc-700 dark:text-zinc-200">{item.name}</p>
        {text === null ? (
          <div className="flex min-h-40 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/60">
            <svg className="h-6 w-6 animate-spin text-accent-500" viewBox="0 0 24 24" fill="none" aria-label="Loading">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
              <path d="M12 2a10 10 0 0110 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </div>
        ) : (
          <pre
            data-testid="snippet-text"
            className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-sm text-zinc-800 select-text dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200"
          >
            {truncated ? text.slice(0, SNIPPET_PREVIEW_CHARS) : text}
          </pre>
        )}
        {truncated && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Showing the first {SNIPPET_PREVIEW_CHARS.toLocaleString()} characters — Copy and Download take all of it.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onDownload}>Download</Button>
          <Button size="sm" onClick={() => void copy()} disabled={text === null}>Copy</Button>
        </div>
      </div>
    </Modal>
  );
}
