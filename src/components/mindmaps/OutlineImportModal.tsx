import { useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { parseOutline } from '../../lib/mindmap-outline';
import { createMindmapFromOutline } from '../../hooks/use-mindmaps';

const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Folder the imported map is created in (undefined = top level). */
  folderId: string | undefined;
  onImported: (mapId: string) => void;
}

// Import a markdown outline ("# Heading" + nested "- " bullets, markmap-style)
// as a new mindmap — pasted or from a .md/.txt file.
export function OutlineImportModal({ open, onClose, folderId, onImported }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function importNow() {
    const parsed = parseOutline(text);
    if ('error' in parsed) {
      toast(parsed.error, 'error');
      return;
    }
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
          Paste a Markdown outline — a <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-700"># heading</code> plus
          nested <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-700">- </code> bullets (2 spaces per level,
          markmap-style) — or pick a .md file.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'# My map\n\n- First idea\n  - Detail\n- Second idea'}
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
        <div className="flex items-center justify-between gap-2">
          <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
            Choose file…
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void importNow()} disabled={busy || text.trim().length === 0}>
              {busy ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
