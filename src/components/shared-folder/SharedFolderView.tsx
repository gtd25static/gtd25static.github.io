import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { StorageBar } from './StorageBar';
import { SharedItemCard } from './SharedItemCard';
import { CreateSnippetForm } from './CreateSnippetForm';
import { PasteUploadDialog } from './PasteUploadDialog';
import {
  useSharedItems,
  useSharedStorage,
  createLinkItem,
  createFileItem,
} from '../../hooks/use-shared-items';
import { isValidUrl, extractUrl } from '../../lib/link-utils';
import { classifyClipboard, type PastePayload } from '../../lib/clipboard-capture';
import { useVault } from '../../hooks/use-vault';
import { toast } from '../ui/Toast';

export function SharedFolderView() {
  const items = useSharedItems();
  const storage = useSharedStorage();
  const { locked } = useVault();
  const [creatingSnippet, setCreatingSnippet] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pastePayload, setPastePayload] = useState<PastePayload | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Add multiple files sequentially so the quota check sees each prior add.
  async function addFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      await createFileItem(file);
    }
  }

  // Clipboard paste → classify (files / link / text) and ask before uploading.
  // Ignored while typing in a field so the snippet textarea keeps normal paste
  // behavior. A newer paste replaces an open preview.
  useEffect(() => {
    if (locked) return;
    function onPaste(e: ClipboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const dt = e.clipboardData;
      if (!dt) return;
      const payload = classifyClipboard(Array.from(dt.files ?? []), dt.getData('text') ?? '');
      if (!payload) return;
      e.preventDefault();
      setPastePayload(payload);
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [locked]);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (locked) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void addFiles(e.dataTransfer.files);
    }
  }

  if (locked) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-zinc-500 dark:text-zinc-400">
        <p className="text-sm">The shared folder is locked. Unlock the vault to view its contents.</p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-1 flex-col overflow-hidden"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* Header: title + storage bar */}
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="mb-2 flex items-center justify-between">
          <h1 className="text-lg font-medium text-zinc-800 dark:text-zinc-100">Shared Folder</h1>
        </div>
        <StorageBar storage={storage} />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
          Upload file
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setCreatingSnippet((v) => !v)}>
          Create text file
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            try {
              const text = (await navigator.clipboard.readText())?.trim();
              const url = text && (isValidUrl(text) ? text : extractUrl(text));
              if (url) await createLinkItem(url);
              else toast('Clipboard has no link to paste.', 'info');
            } catch {
              toast('Paste a link with Ctrl/Cmd+V instead.', 'info');
            }
          }}
        >
          Paste link
        </Button>
        <span className="text-xs text-zinc-400">…or paste / drag &amp; drop anywhere</span>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {creatingSnippet && (
        <div className="px-4 pb-3">
          <CreateSnippetForm onDone={() => setCreatingSnippet(false)} />
        </div>
      )}

      {/* Items */}
      <div className="relative flex-1 overflow-y-auto px-4 pb-6 scrollbar-thin">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-zinc-400">
            <p className="text-sm">Nothing shared yet.</p>
            <p className="mt-1 text-xs">Paste a link, drop a file, or create a text file to get started.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <SharedItemCard key={item.id} item={item} />
            ))}
          </div>
        )}

        {dragOver && (
          <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent-400 bg-accent-50/70 text-sm font-medium text-accent-700 dark:bg-accent-900/30 dark:text-accent-300">
            Drop files to add them
          </div>
        )}
      </div>

      <PasteUploadDialog payload={pastePayload} onClose={() => setPastePayload(null)} />
    </div>
  );
}
