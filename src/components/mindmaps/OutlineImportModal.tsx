import { useMemo, useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { parseOutline } from '../../lib/mindmap-outline';
import { createMindmapFromOutline } from '../../hooks/use-mindmaps';
import { recordError } from '../../lib/diagnostics';

const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Folder the imported map is created in (undefined = top level). */
  folderId: string | undefined;
  onImported: (mapId: string) => void;
}

// Import an outline as a new mindmap — read straight from the clipboard (the
// usual case: "summarize this article as an indented markdown outline" in a
// chatbot, then Copy), typed/pasted by hand, or picked from a .md/.txt file.
// What the text may look like is up to parseOutline; this dialog previews what
// it understood before anything is written.
export function OutlineImportModal({ open, onClose, folderId, onImported }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => (text.trim().length > 0 ? parseOutline(text) : null), [text]);
  const ready = !!parsed && !('error' in parsed);

  async function importNow() {
    if (!parsed || 'error' in parsed) return;
    setBusy(true);
    try {
      const map = await createMindmapFromOutline(parsed.name, parsed.rootLabel, parsed.children, folderId);
      if (!map) return;
      for (const warning of parsed.warnings) toast(warning, 'info');
      setText('');
      onClose();
      onImported(map.id);
    } finally {
      setBusy(false);
    }
  }

  async function pasteFromClipboard() {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        toast('The clipboard is empty.', 'info');
        return;
      }
      setText(clip);
    } catch (err) {
      recordError('mindmapImport.clipboardRead', err);
      toast('Could not read the clipboard — paste with Ctrl/Cmd+V instead.', 'error');
    }
  }

  async function readFile(file: File) {
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      toast('That file is too large for an outline import.', 'error');
      return;
    }
    setText(await file.text());
  }

  return (
    <Modal open={open} onClose={onClose} title="Import outline">
      <div className="space-y-3">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Paste an outline — headings (<code className="rounded bg-zinc-100 px-1 dark:bg-zinc-700">#</code>,{' '}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-700">##</code>) and/or bullets (
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-700">-</code>,{' '}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-700">*</code>,{' '}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-700">1.</code>) indented with spaces or tabs. Plain
          indented text works too. Ask a chatbot for “an indented markdown outline” and copy its answer.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => void pasteFromClipboard()}>
            Paste from clipboard
          </Button>
          <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
            Choose file…
          </Button>
        </div>

        <textarea
          data-redact
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'# My map\n\n## A section\n\n- First idea\n  - Detail\n- Second idea'}
          rows={10}
          className="w-full resize-y rounded-lg border border-zinc-300 bg-white p-2 font-mono text-sm text-zinc-800 outline-none focus:border-accent-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void readFile(file);
            e.target.value = '';
          }}
        />

        {parsed && (
          'error' in parsed ? (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">{parsed.error}</p>
          ) : (
            <div className="rounded-lg bg-zinc-50 p-2 text-xs dark:bg-zinc-800/60">
              <p className="text-zinc-500 dark:text-zinc-400">
                {parsed.format === 'indent' ? 'Indented outline' : 'Markdown outline'} · {parsed.nodeCount} node(s) ·{' '}
                {parsed.children.length} top-level branch(es)
              </p>
              <p data-redact className="truncate text-zinc-700 dark:text-zinc-200">Root: {parsed.name}</p>
              {parsed.warnings.map((w) => (
                <p key={w} className="mt-1 text-amber-600 dark:text-amber-400">{w}</p>
              ))}
            </div>
          )
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void importNow()} disabled={busy || !ready}>
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
