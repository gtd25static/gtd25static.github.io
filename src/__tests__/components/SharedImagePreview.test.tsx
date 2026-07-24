// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup-component';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SharedItem } from '../../db/models';

const getSharedBlobBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
const writeClipboardItemWithHygiene = vi.fn(async (..._items: unknown[]) => undefined);
vi.mock('../../sync/shared-blobs', () => ({
  getSharedBlobBytes: (...a: unknown[]) => (getSharedBlobBytes as (...x: unknown[]) => unknown)(...a),
}));
vi.mock('../../lib/clipboard-hygiene', () => ({
  writeClipboardItemWithHygiene: (...a: unknown[]) => writeClipboardItemWithHygiene(...a),
}));
vi.mock('../../hooks/use-shared-items', () => ({
  formatBytes: (n: number) => `${n} B`,
  deleteSharedItem: vi.fn(),
}));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

import { SharedImagePreview } from '../../components/shared-folder/SharedImagePreview';
import { SharedItemCard } from '../../components/shared-folder/SharedItemCard';
import { toast } from '../../components/ui/Toast';

class FakeClipboardItem {
  parts: Record<string, Blob>;
  constructor(parts: Record<string, Blob>) { this.parts = parts; }
}

function item(over: Partial<SharedItem> = {}): SharedItem {
  return {
    id: 'i1', type: 'file', name: 'shot.png', size: 3, blobId: 'b1',
    mimeType: 'image/png', order: 0, createdAt: 1, updatedAt: 1,
    ...over,
  } as SharedItem;
}

let anchorClicks = 0;

beforeEach(() => {
  getSharedBlobBytes.mockClear();
  writeClipboardItemWithHygiene.mockClear();
  vi.mocked(toast).mockClear();
  anchorClicks = 0;
  // jsdom has no createObjectURL / ClipboardItem / clipboard — stub them.
  URL.createObjectURL = vi.fn(() => 'blob:fake-url');
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write: vi.fn(async () => undefined) },
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    anchorClicks++;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SharedImagePreview', () => {
  it('shows the decrypted image inline instead of downloading', async () => {
    render(<SharedImagePreview item={item()} filename="shot.png" onClose={() => {}} />);
    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', 'blob:fake-url');
    expect(getSharedBlobBytes).toHaveBeenCalledWith('b1');
    expect(anchorClicks).toBe(0);
  });

  it('Copy puts a PNG on the clipboard through the hygiene wrapper (auto-clear applies)', async () => {
    render(<SharedImagePreview item={item()} filename="shot.png" onClose={() => {}} />);
    await screen.findByRole('img');

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeClipboardItemWithHygiene).toHaveBeenCalledTimes(1));
    const [items] = writeClipboardItemWithHygiene.mock.calls[0] as unknown as [FakeClipboardItem[]];
    expect(items[0]).toBeInstanceOf(FakeClipboardItem);
    expect(Object.keys(items[0].parts)).toEqual(['image/png']);
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining('copied'), 'success');
  });

  it('Download uses the loaded bytes with the proper filename', async () => {
    render(<SharedImagePreview item={item()} filename="shot.png" onClose={() => {}} />);
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(anchorClicks).toBe(1);
  });

  it('closes with an error toast when the blob cannot be loaded', async () => {
    getSharedBlobBytes.mockRejectedValueOnce(new Error('NO_SYNC_KEY'));
    const onClose = vi.fn();
    render(<SharedImagePreview item={item()} filename="shot.png" onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining('Unlock the vault'), 'error');
  });
});

describe('SharedItemCard routing', () => {
  it('clicking an image name opens the preview dialog, not a download', async () => {
    render(<SharedItemCard item={item()} />);
    fireEvent.click(screen.getByRole('button', { name: 'shot.png' }));
    await screen.findByRole('img'); // preview loaded inside the dialog
    expect(document.querySelector('dialog')).toBeTruthy();
    expect(anchorClicks).toBe(0);
  });

  it('clicking a non-image name still downloads directly', async () => {
    render(<SharedItemCard item={item({ name: 'doc.pdf', mimeType: 'application/pdf' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'doc.pdf' }));
    await waitFor(() => expect(anchorClicks).toBe(1));
    expect(document.querySelector('dialog')).toBeNull();
    expect(getSharedBlobBytes).toHaveBeenCalledWith('b1');
  });
});
