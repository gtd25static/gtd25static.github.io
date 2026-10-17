// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SharedItem } from '../../db/models';

const getSharedBlobBytes = vi.fn(async (..._a: unknown[]) => new TextEncoder().encode('line one\n<b>not bold</b> ñ'));
const writeTextWithHygiene = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../sync/shared-blobs', () => ({
  getSharedBlobBytes: (...a: unknown[]) => getSharedBlobBytes(...a),
}));
vi.mock('../../lib/clipboard-hygiene', () => ({
  writeTextWithHygiene: (...a: unknown[]) => writeTextWithHygiene(...a),
  writeClipboardItemWithHygiene: vi.fn(),
}));
vi.mock('../../hooks/use-shared-items', () => ({
  formatBytes: (n: number) => `${n} B`,
  sharedItemExpiry: () => undefined,
  deleteSharedItem: vi.fn(),
}));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

import { SharedTextPreview } from '../../components/shared-folder/SharedTextPreview';
import { SharedItemCard } from '../../components/shared-folder/SharedItemCard';
import { SNIPPET_PREVIEW_CHARS } from '../../components/shared-folder/snippet-text';
import { toast } from '../../components/ui/Toast';

function snippet(over: Partial<SharedItem> = {}): SharedItem {
  return {
    id: 's1', type: 'snippet', name: 'notes', size: 30, blobId: 'b1',
    mimeType: 'text/plain', order: 0, createdAt: 1, updatedAt: 1,
    ...over,
  } as SharedItem;
}

let anchorClicks = 0;

beforeEach(() => {
  getSharedBlobBytes.mockClear();
  writeTextWithHygiene.mockClear();
  vi.mocked(toast).mockClear();
  anchorClicks = 0;
  URL.createObjectURL = vi.fn(() => 'blob:fake-url');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { anchorClicks++; });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('SharedTextPreview', () => {
  it('shows the text inline, as text — markup stays literal', async () => {
    const { container } = render(<SharedTextPreview item={snippet()} onDownload={() => {}} onClose={() => {}} />);
    const pre = await screen.findByTestId('snippet-text');
    expect(pre.textContent).toBe('line one\n<b>not bold</b> ñ');
    expect(container.ownerDocument.querySelector('pre b')).toBeNull();
    expect(getSharedBlobBytes).toHaveBeenCalledWith('b1', 30);
  });

  it('Copy puts the whole text on the clipboard through the hygiene wrapper', async () => {
    const user = userEvent.setup();
    render(<SharedTextPreview item={snippet()} onDownload={() => {}} onClose={() => {}} />);
    await screen.findByTestId('snippet-text');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeTextWithHygiene).toHaveBeenCalledWith('line one\n<b>not bold</b> ñ');
    expect(toast).toHaveBeenCalledWith('Text copied', 'success');
  });

  it('a huge snippet shows only its start, but Copy still takes all of it', async () => {
    const user = userEvent.setup();
    const big = 'x'.repeat(SNIPPET_PREVIEW_CHARS + 10);
    getSharedBlobBytes.mockResolvedValueOnce(new TextEncoder().encode(big));
    render(<SharedTextPreview item={snippet()} onDownload={() => {}} onClose={() => {}} />);
    const pre = await screen.findByTestId('snippet-text');
    expect(pre.textContent).toHaveLength(SNIPPET_PREVIEW_CHARS);
    expect(screen.getByText(/Showing the first/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeTextWithHygiene).toHaveBeenCalledWith(big);
  });

  it('a load failure says so and closes', async () => {
    getSharedBlobBytes.mockRejectedValueOnce(new Error('NO_SYNC_KEY'));
    const onClose = vi.fn();
    render(<SharedTextPreview item={snippet()} onDownload={() => {}} onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith('Unlock the vault / set up sync to open this item.', 'error');
  });
});

describe('SharedItemCard — snippets', () => {
  it('clicking the name opens the preview instead of downloading', async () => {
    const user = userEvent.setup();
    render(<SharedItemCard item={snippet()} />);
    await user.click(screen.getByRole('button', { name: 'notes' }));
    expect(await screen.findByTestId('snippet-text')).toHaveTextContent('line one');
    expect(anchorClicks).toBe(0);
    const dialog = screen.getByTestId('snippet-text').closest('[data-redact]') as HTMLElement;
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(anchorClicks).toBe(1));
  });

  it('Copy text copies straight from the card', async () => {
    const user = userEvent.setup();
    render(<SharedItemCard item={snippet()} />);
    await user.click(screen.getByRole('button', { name: 'Copy text' }));
    await waitFor(() => expect(writeTextWithHygiene).toHaveBeenCalledWith('line one\n<b>not bold</b> ñ'));
    expect(screen.queryByTestId('snippet-text')).toBeNull();
    expect(anchorClicks).toBe(0);
  });

  it('a clipboard refusal is reported, not swallowed', async () => {
    const user = userEvent.setup();
    writeTextWithHygiene.mockRejectedValueOnce(new Error('NotAllowedError'));
    render(<SharedItemCard item={snippet()} />);
    await user.click(screen.getByRole('button', { name: 'Copy text' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Could not copy the text', 'error'));
  });

  it('files other than images still download on click, and get no Copy text', async () => {
    const user = userEvent.setup();
    render(<SharedItemCard item={snippet({ type: 'file', name: 'report.pdf', mimeType: 'application/pdf' })} />);
    expect(screen.queryByRole('button', { name: 'Copy text' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'report.pdf' }));
    await waitFor(() => expect(anchorClicks).toBe(1));
  });
});
