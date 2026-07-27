// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';

const mockCreateFromOutline = vi.fn(async () => ({ id: 'map-1' }));
const mockToast = vi.fn();

vi.mock('../../hooks/use-mindmaps', () => ({
  createMindmapFromOutline: (...args: unknown[]) => (mockCreateFromOutline as (...a: unknown[]) => unknown)(...args),
}));
vi.mock('../../components/ui/Toast', () => ({
  toast: (...args: unknown[]) => mockToast(...args),
}));

import { OutlineImportModal } from '../../components/mindmaps/OutlineImportModal';

function renderModal(overrides: Partial<Parameters<typeof OutlineImportModal>[0]> = {}) {
  const onImported = vi.fn();
  const onClose = vi.fn();
  render(
    <OutlineImportModal open onClose={onClose} folderId={undefined} onImported={onImported} {...overrides} />,
  );
  return { onImported, onClose };
}

function stubClipboard(readText: () => Promise<string>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OutlineImportModal', () => {
  it('fills the outline from the clipboard and previews what it parsed', async () => {
    const user = userEvent.setup();
    stubClipboard(async () => '# Sleep\n\n## Ideas\n\n- One\n  - Detail\n- Two\n');
    renderModal();

    await user.click(screen.getByRole('button', { name: /paste from clipboard/i }));

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('# Sleep\n\n## Ideas\n\n- One\n  - Detail\n- Two\n');
    });
    // root + Ideas + One + Detail + Two
    expect(screen.getByText(/Markdown outline · 5 node\(s\)/)).toBeInTheDocument();
    expect(screen.getByText('Root: Sleep')).toBeInTheDocument();
  });

  it('reports a clipboard read failure instead of silently doing nothing', async () => {
    const user = userEvent.setup();
    stubClipboard(async () => { throw new Error('denied'); });
    renderModal();

    await user.click(screen.getByRole('button', { name: /paste from clipboard/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/clipboard/i), 'error');
    });
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('says so when the clipboard has nothing to import', async () => {
    const user = userEvent.setup();
    stubClipboard(async () => '   \n  ');
    renderModal();

    await user.click(screen.getByRole('button', { name: /paste from clipboard/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/empty/i), 'info');
    });
  });

  it('imports the parsed outline and opens the new map', async () => {
    const user = userEvent.setup();
    stubClipboard(async () => '# Trip\n\n- Pack\n- Book flight\n');
    const { onImported, onClose } = renderModal({ folderId: 'folder-9' });

    await user.click(screen.getByRole('button', { name: /paste from clipboard/i }));
    await waitFor(() => expect(screen.getByRole('textbox')).not.toHaveValue(''));
    await user.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(mockCreateFromOutline).toHaveBeenCalledTimes(1));
    const [name, rootLabel, children, folderId] = mockCreateFromOutline.mock.calls[0] as unknown as [
      string, string, Array<{ label: string }>, string,
    ];
    expect(name).toBe('Trip');
    expect(rootLabel).toBe('Trip');
    expect(children.map((c) => c.label)).toEqual(['Pack', 'Book flight']);
    expect(folderId).toBe('folder-9');
    expect(onClose).toHaveBeenCalled();
    expect(onImported).toHaveBeenCalledWith('map-1');
  });

  it('keeps Import disabled while the text parses to nothing', async () => {
    const user = userEvent.setup();
    renderModal();
    const importButton = screen.getByRole('button', { name: 'Import' });
    expect(importButton).toBeDisabled();

    await user.type(screen.getByRole('textbox'), '---');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/No outline content/i));
    expect(importButton).toBeDisabled();
  });
});
