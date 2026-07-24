// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import '../setup-component';
import { vi, describe, it, expect } from 'vitest';

vi.mock('../../hooks/use-shared-items', () => ({ formatBytes: (n: number) => `${n} B` }));

import { ShareTargetPrompt } from '../../components/banners/ShareTargetPrompt';
import type { PendingShare } from '../../hooks/use-share-target';

function makeApi(pendingShare: PendingShare | null) {
  return {
    pendingShare,
    resolveShare: vi.fn(),
    discardShare: vi.fn(),
    postponeShare: vi.fn(),
  };
}

const fileShare: PendingShare = {
  files: [new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' })],
  title: '', url: '', text: '',
};

const textShare: PendingShare = { files: [], title: 'Cool page', url: 'https://example.com/x', text: '' };

describe('ShareTargetPrompt', () => {
  it('renders nothing without a pending share', () => {
    const { container } = render(<ShareTargetPrompt {...makeApi(null)} />);
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('previews shared files and routes the two destination choices', () => {
    const api = makeApi(fileShare);
    render(<ShareTargetPrompt {...api} />);
    expect(screen.getByText(/photo\.png/)).toBeInTheDocument();
    expect(screen.getByText(/\(3 B\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }));
    expect(api.resolveShare).toHaveBeenCalledWith('inbox');
    fireEvent.click(screen.getByRole('button', { name: 'Save to Shared Folder' }));
    expect(api.resolveShare).toHaveBeenCalledWith('shared-folder');
  });

  it('previews shared text/links and offers Discard', () => {
    const api = makeApi(textShare);
    render(<ShareTargetPrompt {...api} />);
    expect(screen.getByText(/Cool page — https:\/\/example\.com\/x/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(api.discardShare).toHaveBeenCalled();
  });

  it('closing the dialog postpones instead of discarding', () => {
    const api = makeApi(fileShare);
    render(<ShareTargetPrompt {...api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(api.postponeShare).toHaveBeenCalled();
    expect(api.discardShare).not.toHaveBeenCalled();
  });
});
