// @vitest-environment jsdom
//
// Pins the "Delete all" toolbar action: it only appears when the folder has
// items, it never deletes without an explicit confirmation, and it delegates to
// deleteAllSharedItems (which reuses the per-item delete path).
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup-component';
import type { SharedItem } from '../../db/models';

const h = vi.hoisted(() => ({
  items: [] as SharedItem[],
  deleteAllSharedItems: vi.fn(async () => h.items.length),
  confirmDialog: vi.fn(async (_msg: string, _opts?: unknown) => true),
}));

vi.mock('../../hooks/use-shared-items', () => ({
  useSharedItems: () => h.items,
  useSharedStorage: () => ({ usedBytes: 0, totalBytes: 30 * 1024 * 1024, remaining: 30 * 1024 * 1024 }),
  createFileItem: vi.fn(),
  createLinkItem: vi.fn(),
  createSnippetItem: vi.fn(),
  deleteSharedItem: vi.fn(),
  deleteAllSharedItems: h.deleteAllSharedItems,
  formatBytes: (n: number) => `${n} B`,
}));
vi.mock('../../sync/shared-blobs', () => ({ getSharedBlobBytes: vi.fn() }));
vi.mock('../../hooks/use-vault', () => ({ useVault: () => ({ locked: false }) }));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../components/ui/ConfirmDialog', () => ({ confirmDialog: h.confirmDialog }));

import { SharedFolderView } from '../../components/shared-folder/SharedFolderView';
import { toast } from '../../components/ui/Toast';

function item(id: string, over: Partial<SharedItem> = {}): SharedItem {
  return {
    id, type: 'link', name: `Item ${id}`, size: 10, url: 'https://example.com',
    order: 0, createdAt: 1, updatedAt: 1, ...over,
  } as SharedItem;
}

beforeEach(() => {
  h.items = [item('a'), item('b')];
  h.deleteAllSharedItems.mockClear();
  h.confirmDialog.mockClear();
  h.confirmDialog.mockResolvedValue(true);
  vi.mocked(toast).mockClear();
});

describe('SharedFolderView — Delete all', () => {
  it('is hidden while the folder is empty', () => {
    h.items = [];
    render(<SharedFolderView />);
    expect(screen.queryByRole('button', { name: 'Delete all' })).toBeNull();
  });

  it('asks for confirmation before deleting anything', async () => {
    render(<SharedFolderView />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));

    await waitFor(() => expect(h.confirmDialog).toHaveBeenCalledTimes(1));
    const [message, options] = h.confirmDialog.mock.calls[0] as [string, { confirmLabel?: string; danger?: boolean }];
    expect(message).toContain('2 items');
    expect(message).toContain('cannot be undone');
    expect(options).toMatchObject({ confirmLabel: 'Delete all', danger: true });
  });

  it('deletes everything once confirmed and reports the count', async () => {
    render(<SharedFolderView />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));

    await waitFor(() => expect(h.deleteAllSharedItems).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining('Deleted 2 items'), 'success');
  });

  it('deletes nothing when the confirmation is declined', async () => {
    h.confirmDialog.mockResolvedValue(false);
    render(<SharedFolderView />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));

    await waitFor(() => expect(h.confirmDialog).toHaveBeenCalledTimes(1));
    expect(h.deleteAllSharedItems).not.toHaveBeenCalled();
    expect(vi.mocked(toast)).not.toHaveBeenCalled();
  });

  it('singularises the prompt for a lone item', async () => {
    h.items = [item('a')];
    render(<SharedFolderView />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));

    await waitFor(() => expect(h.confirmDialog).toHaveBeenCalledTimes(1));
    expect(h.confirmDialog.mock.calls[0][0]).toContain('1 item from');
  });
});
