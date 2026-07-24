import { useEffect, useState } from 'react';
import type { SharedItem } from '../../db/models';
import { getSharedBlobBytes } from '../../sync/shared-blobs';
import { writeClipboardItemWithHygiene } from '../../lib/clipboard-hygiene';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';

// Clipboard images must be PNG; rasterise other formats through a canvas.
async function toPngBlob(source: Blob): Promise<Blob | null> {
  if (source.type === 'image/png') return source;
  try {
    const bmp = await createImageBitmap(source);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null;
  }
}

// Overlay preview for an image item: shows the decrypted bytes inline (no
// automatic download) with Copy — the "paste it into another app" workflow —
// and an explicit Download. Copy goes through the clipboard-hygiene wrapper so
// the Paranoid auto-clear extra applies to images exactly as it does to text.
export function SharedImagePreview({ item, filename, onClose }: {
  item: SharedItem;
  filename: string;
  onClose: () => void;
}) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        if (!item.blobId) throw new Error('missing blob');
        const bytes = await getSharedBlobBytes(item.blobId);
        if (!active) return;
        const loaded = new Blob([bytes.slice().buffer], { type: item.mimeType || 'application/octet-stream' });
        objectUrl = URL.createObjectURL(loaded);
        setBlob(loaded);
        setUrl(objectUrl);
      } catch (err) {
        const msg = err instanceof Error && err.message === 'NO_SYNC_KEY'
          ? 'Unlock the vault / set up sync to open this item.'
          : 'Could not load this image.';
        toast(msg, 'error');
        if (active) onClose();
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // Reload only if the item itself changes — onClose identity is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.blobId, item.mimeType]);

  async function copy() {
    if (!blob) return;
    setCopying(true);
    try {
      const png = await toPngBlob(blob);
      if (!png || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        toast('Copying images isn’t supported here — use Download', 'error');
        return;
      }
      await writeClipboardItemWithHygiene([new ClipboardItem({ 'image/png': png })]);
      toast('Image copied — paste it anywhere', 'success');
    } catch {
      toast('Could not copy the image', 'error');
    } finally {
      setCopying(false);
    }
  }

  function download() {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <Modal open onClose={onClose} title={item.name || 'Image'}>
      <div className="space-y-4" data-redact>
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/60">
          {url ? (
            <img src={url} alt={item.name} className="max-h-[65vh] max-w-full rounded-lg object-contain" />
          ) : (
            <svg className="my-16 h-6 w-6 animate-spin text-accent-500" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
              <path d="M12 2a10 10 0 0110 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={download} disabled={!url}>Download</Button>
          <Button size="sm" onClick={() => void copy()} disabled={!blob || copying}>
            {copying ? 'Copying…' : 'Copy'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
