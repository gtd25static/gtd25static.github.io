// @vitest-environment jsdom
//
// Regression guard for the shared folder on phones: the Download/Delete icons
// used to be revealed by `group-hover` only, which never fires on a touch
// screen — the buttons were there but permanently invisible, so files could
// not be deleted from a phone. They must stay visible below `md`.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup-component';
import type { SharedItem } from '../../db/models';

vi.mock('../../hooks/use-shared-items', () => ({
  formatBytes: (n: number) => `${n} B`,
  deleteSharedItem: vi.fn(async (_id: string) => undefined),
}));
vi.mock('../../sync/shared-blobs', () => ({ getSharedBlobBytes: vi.fn() }));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../components/ui/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }));

import { SharedItemCard } from '../../components/shared-folder/SharedItemCard';
import { deleteSharedItem } from '../../hooks/use-shared-items';
import { confirmDialog } from '../../components/ui/ConfirmDialog';

function item(over: Partial<SharedItem> = {}): SharedItem {
  return {
    id: 'i1', type: 'file', name: 'doc.pdf', size: 3, blobId: 'b1',
    mimeType: 'application/pdf', order: 0, createdAt: 1, updatedAt: 1,
    ...over,
  } as SharedItem;
}

// A class hides the element on every viewport unless it is breakpoint-scoped
// (`md:opacity-0`) — the unprefixed form is the bug this file pins.
function hidesOnPhones(el: Element): boolean {
  return Array.from(el.classList).some((c) => c === 'opacity-0' || c === 'hidden' || c === 'invisible');
}

beforeEach(() => {
  vi.mocked(deleteSharedItem).mockClear();
  vi.mocked(confirmDialog).mockClear();
});

describe('SharedItemCard — actions on a phone', () => {
  it.each(['Delete', 'Download'])('%s is not hidden by a hover-only class', (label) => {
    const { container } = render(<SharedItemCard item={item()} />);
    let el: Element | null = screen.getByRole('button', { name: label });
    while (el && el !== container) {
      expect(hidesOnPhones(el)).toBe(false);
      el = el.parentElement;
    }
  });

  it('keeps a 44px tap target for both actions below md', () => {
    render(<SharedItemCard item={item()} />);
    for (const label of ['Delete', 'Download']) {
      const btn = screen.getByRole('button', { name: label });
      expect(btn.className).toContain('min-h-[44px]');
      expect(btn.className).toContain('min-w-[44px]');
    }
  });

  it('tapping Delete confirms and removes the item', async () => {
    render(<SharedItemCard item={item()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteSharedItem).toHaveBeenCalledWith('i1'));
    expect(confirmDialog).toHaveBeenCalledTimes(1);
  });

  it('a link item still offers Delete (no Download)', () => {
    render(<SharedItemCard item={item({ type: 'link', url: 'https://example.com', name: 'Example' })} />);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });
});
