// @vitest-environment jsdom
//
// Pins the Shared Folder's paste-to-upload flow: Ctrl+V content is classified
// (file / link / text), previewed in a dialog, and uploaded only on approval
// through the existing createXxxItem APIs.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { SharedFolderView } from '../../components/shared-folder/SharedFolderView';

const h = vi.hoisted(() => ({
  createFileItem: vi.fn(async (_file: File) => undefined),
  createLinkItem: vi.fn(async (_url: string, _title?: string) => undefined),
  createSnippetItem: vi.fn(async (_name: string, _text: string) => undefined),
}));

vi.mock('../../hooks/use-shared-items', () => ({
  useSharedItems: () => [],
  useSharedStorage: () => ({ usedBytes: 0, totalBytes: 30 * 1024 * 1024, remaining: 30 * 1024 * 1024 }),
  createFileItem: h.createFileItem,
  createLinkItem: h.createLinkItem,
  createSnippetItem: h.createSnippetItem,
  deleteSharedItem: vi.fn(),
  formatBytes: (n: number) => `${n} B`,
}));
vi.mock('../../sync/shared-blobs', () => ({ getSharedBlobBytes: vi.fn() }));
vi.mock('../../hooks/use-vault', () => ({ useVault: () => ({ locked: false }) }));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

function firePaste(opts: { files?: File[]; text?: string }, target: EventTarget = document) {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: { files: opts.files ?? [], getData: () => opts.text ?? '' },
  });
  act(() => {
    target.dispatchEvent(e);
  });
}

beforeAll(() => {
  // jsdom lacks object URLs; the dialog feature-guards on them.
  URL.createObjectURL = vi.fn(() => 'blob:mock') as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
});

beforeEach(() => {
  h.createFileItem.mockClear();
  h.createLinkItem.mockClear();
  h.createSnippetItem.mockClear();
});

describe('SharedFolderView — paste to upload', () => {
  it('previews a pasted image and uploads it on approval', async () => {
    const user = userEvent.setup();
    render(<SharedFolderView />);

    const shot = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
    firePaste({ files: [shot] });

    expect(screen.getByText('Upload image from clipboard?')).toBeInTheDocument();
    expect(screen.getByAltText('Pasted image preview')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('image.png');
    expect(h.createFileItem).not.toHaveBeenCalled(); // nothing before approval

    await user.click(screen.getByRole('button', { name: 'Upload' }));

    await waitFor(() => expect(h.createFileItem).toHaveBeenCalledTimes(1));
    expect(h.createFileItem.mock.calls[0][0].name).toBe('image.png');
    expect(screen.queryByText('Upload image from clipboard?')).not.toBeInTheDocument();
  });

  it('uploads with the edited name when the file is renamed in the prompt', async () => {
    const user = userEvent.setup();
    render(<SharedFolderView />);

    firePaste({ files: [new File(['x'], 'notes.pdf', { type: 'application/pdf' })] });

    const nameField = screen.getByLabelText('Name');
    await user.clear(nameField);
    await user.type(nameField, 'renamed.pdf');
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    await waitFor(() => expect(h.createFileItem).toHaveBeenCalledTimes(1));
    const uploaded = h.createFileItem.mock.calls[0][0];
    expect(uploaded.name).toBe('renamed.pdf');
    expect(uploaded.type).toBe('application/pdf');
  });

  it('does not upload when the prompt is cancelled', async () => {
    const user = userEvent.setup();
    render(<SharedFolderView />);

    firePaste({ files: [new File(['x'], 'image.png', { type: 'image/png' })] });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(h.createFileItem).not.toHaveBeenCalled();
    expect(screen.queryByText('Upload image from clipboard?')).not.toBeInTheDocument();
  });

  it('previews a pasted URL as a link and uploads it on approval', async () => {
    const user = userEvent.setup();
    render(<SharedFolderView />);

    firePaste({ text: 'https://example.com/article' });

    expect(screen.getByText('Upload link from clipboard?')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/article')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Upload' }));

    await waitFor(() => expect(h.createLinkItem).toHaveBeenCalledWith('https://example.com/article', undefined));
  });

  it('previews pasted text as a snippet and uploads it on approval', async () => {
    const user = userEvent.setup();
    render(<SharedFolderView />);

    firePaste({ text: 'meeting notes: discuss roadmap' });

    expect(screen.getByText('Upload text from clipboard?')).toBeInTheDocument();
    expect(screen.getByText('meeting notes: discuss roadmap')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Upload' }));

    await waitFor(() =>
      expect(h.createSnippetItem).toHaveBeenCalledWith('Snippet', 'meeting notes: discuss roadmap'));
  });

  it('lists multiple pasted files without a rename field', () => {
    render(<SharedFolderView />);

    firePaste({
      files: [
        new File(['a'], 'one.txt', { type: 'text/plain' }),
        new File(['bb'], 'two.txt', { type: 'text/plain' }),
      ],
    });

    expect(screen.getByText('Upload from clipboard?')).toBeInTheDocument();
    expect(screen.getByText('one.txt')).toBeInTheDocument();
    expect(screen.getByText('two.txt')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('ignores paste while typing in an input', () => {
    const { container } = render(<SharedFolderView />);

    const fileInput = container.querySelector('input[type="file"]')!;
    firePaste({ text: 'https://example.com' }, fileInput);

    expect(screen.queryByText('Upload link from clipboard?')).not.toBeInTheDocument();
  });
});
