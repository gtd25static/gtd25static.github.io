import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import {
  createFileItem,
  createLinkItem,
  createSnippetItem,
  formatBytes,
} from '../../hooks/use-shared-items';
import type { PastePayload } from '../../lib/clipboard-capture';

const SNIPPET_PREVIEW_CHARS = 500;

interface Props {
  payload: PastePayload | null;
  onClose: () => void;
}

/**
 * Confirm-before-upload preview for clipboard pastes in the Shared Folder.
 * Shows the recognized content (image thumbnail, file list, URL, or text) and
 * uploads through the existing createXxxItem APIs on approval, so the quota
 * check, encryption, and sync apply unchanged.
 */
export function PasteUploadDialog({ payload, onClose }: Props) {
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState(false);

  const singleFile = payload?.kind === 'files' && payload.files.length === 1 ? payload.files[0] : null;
  const isImage = !!singleFile && singleFile.type.startsWith('image/');

  // Reset the editable name whenever a new payload arrives.
  useEffect(() => {
    if (!payload) return;
    setUploading(false);
    if (payload.kind === 'files' && payload.files.length === 1) setName(payload.files[0].name || 'file');
    else if (payload.kind === 'snippet') setName('Snippet');
    else setName('');
  }, [payload]);

  // Thumbnail object URL for a single pasted image; revoked on change/close.
  // (Feature-guarded: jsdom and some embedders lack createObjectURL.)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage || !singleFile || typeof URL.createObjectURL !== 'function') {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(singleFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [isImage, singleFile]);

  if (!payload) return null;

  async function handleUpload() {
    if (!payload || uploading) return;
    setUploading(true);
    try {
      if (payload.kind === 'files') {
        if (payload.files.length === 1) {
          const file = payload.files[0];
          const finalName = name.trim() || file.name || 'file';
          const renamed = finalName === file.name ? file : new File([file], finalName, { type: file.type });
          await createFileItem(renamed);
        } else {
          // Sequential so the quota check sees each prior add (same as addFiles).
          for (const file of payload.files) {
            await createFileItem(file);
          }
        }
      } else if (payload.kind === 'link') {
        await createLinkItem(payload.url, name.trim() || undefined);
      } else {
        await createSnippetItem(name.trim() || 'Snippet', payload.text);
      }
    } finally {
      onClose();
    }
  }

  const title =
    payload.kind === 'link' ? 'Upload link from clipboard?'
      : payload.kind === 'snippet' ? 'Upload text from clipboard?'
        : payload.files.length === 1 && isImage ? 'Upload image from clipboard?'
          : 'Upload from clipboard?';

  return (
    <Modal open onClose={onClose} title={title}>
      <div className="space-y-3">
        {payload.kind === 'files' && singleFile && (
          <>
            {previewUrl && (
              <img
                src={previewUrl}
                alt="Pasted image preview"
                className="max-h-56 w-full rounded-lg border border-zinc-200 object-contain dark:border-zinc-700"
              />
            )}
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              {singleFile.type || 'application/octet-stream'} · {formatBytes(singleFile.size)}
            </p>
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          </>
        )}

        {payload.kind === 'files' && payload.files.length > 1 && (
          <div className="space-y-1">
            {payload.files.map((f, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700"
              >
                <span className="truncate text-zinc-700 dark:text-zinc-300">{f.name || `file-${i + 1}`}</span>
                <span className="ml-3 shrink-0 text-xs text-zinc-400">{formatBytes(f.size)}</span>
              </div>
            ))}
          </div>
        )}

        {payload.kind === 'link' && (
          <>
            <p className="break-all rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300">
              {payload.url}
            </p>
            <Input label="Title (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder={payload.url} />
          </>
        )}

        {payload.kind === 'snippet' && (
          <>
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300">
              {payload.text.length > SNIPPET_PREVIEW_CHARS
                ? `${payload.text.slice(0, SNIPPET_PREVIEW_CHARS)}… (+${payload.text.length - SNIPPET_PREVIEW_CHARS} chars)`
                : payload.text}
            </pre>
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void handleUpload()} disabled={uploading}>
            {uploading ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
