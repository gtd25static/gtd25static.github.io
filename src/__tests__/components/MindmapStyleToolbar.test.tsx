// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import type { MindmapNode } from '../../db/models';

const mockUpdateStyle = vi.fn(async () => true);
const mockSetBackground = vi.fn(async () => true);
vi.mock('../../hooks/use-mindmaps', () => ({
  updateMindmapNodeStyle: (...a: unknown[]) => (mockUpdateStyle as (...x: unknown[]) => unknown)(...a),
  setMindmapBackground: (...a: unknown[]) => (mockSetBackground as (...x: unknown[]) => unknown)(...a),
}));

import { MindmapStyleToolbar } from '../../components/mindmaps/MindmapStyleToolbar';
import { useMindmapUi } from '../../stores/mindmap-ui';

function node(overrides: Partial<MindmapNode> = {}): MindmapNode {
  return {
    id: 'n1', mapId: 'map-1', parentId: 'root', label: 'A node',
    order: 0, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

const NODES = [node({ id: 'root', parentId: undefined }), node(), node({ id: 'n2', parentId: 'n1' })];

/** Note: no default for `selected` — passing undefined must mean "nothing selected". */
function renderBar(selected: MindmapNode | undefined, background?: string) {
  return render(
    <MindmapStyleToolbar
      mapId="map-1"
      node={selected}
      isRoot={!!selected && !selected.parentId}
      nodes={NODES}
      background={background}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem('gtd25-mindmap-ui');
  useMindmapUi.setState({ selectedNodeId: 'n1', stylePreview: null, collapsed: {}, customPalettes: [] });
});

describe('MindmapStyleToolbar — node formatting', () => {
  it('offers the three shapes and marks the current one', () => {
    renderBar(node({ shape: 'circle' }));
    expect(screen.getByLabelText('Circle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Rounded rectangle')).toHaveAttribute('aria-pressed', 'false');
  });

  it('applies a shape and a preset', async () => {
    const user = userEvent.setup();
    renderBar(node());
    await user.click(screen.getByLabelText('Decision diamond'));
    expect(mockUpdateStyle).toHaveBeenCalledWith('n1', { shape: 'diamond' });

    await user.click(screen.getByLabelText('Mint'));
    expect(mockUpdateStyle).toHaveBeenCalledWith('n1', {
      palette: 'mint', colorBg: null, colorFg: null, colorBorder: null,
    });
  });

  it('previews a preset on hover and takes it back on leave', () => {
    renderBar(node());
    const rose = screen.getByLabelText('Rose');
    fireEvent.pointerEnter(rose, { pointerType: 'mouse' });
    expect(useMindmapUi.getState().stylePreview).toMatchObject({ palette: 'rose' });
    fireEvent.pointerLeave(rose);
    expect(useMindmapUi.getState().stylePreview).toBeNull();
  });

  it('does not preview on touch (there is no hover to take back)', () => {
    renderBar(node());
    fireEvent.pointerEnter(screen.getByLabelText('Rose'), { pointerType: 'touch' });
    expect(useMindmapUi.getState().stylePreview).toBeNull();
  });

  it('drops the preview when the toolbar goes away', () => {
    const { unmount } = renderBar(node());
    fireEvent.pointerEnter(screen.getByLabelText('Sky'), { pointerType: 'mouse' });
    expect(useMindmapUi.getState().stylePreview).not.toBeNull();
    unmount();
    expect(useMindmapUi.getState().stylePreview).toBeNull();
  });
});

describe('MindmapStyleToolbar — with nothing selected', () => {
  it('disables the node controls but keeps the view and canvas ones live', () => {
    renderBar(undefined);
    expect(screen.getByLabelText('Circle')).toBeDisabled();
    expect(screen.getByLabelText('Mint')).toBeDisabled();
    expect(screen.getByLabelText('Advanced colours')).toBeDisabled();

    expect(screen.getByLabelText('Expand all')).toBeEnabled();
    expect(screen.getByLabelText('Collapse all')).toBeEnabled();
    expect(screen.getByLabelText('Canvas background')).toBeEnabled();
  });

  it('never previews or writes from a disabled control', () => {
    renderBar(undefined);
    fireEvent.pointerEnter(screen.getByLabelText('Rose'), { pointerType: 'mouse' });
    expect(useMindmapUi.getState().stylePreview).toBeNull();
    fireEvent.click(screen.getByLabelText('Rose'));
    expect(mockUpdateStyle).not.toHaveBeenCalled();
  });
});

describe('MindmapStyleToolbar — expand/collapse all', () => {
  it('collapses every node that has children, and expands them all back', async () => {
    const user = userEvent.setup();
    renderBar(node());
    await user.click(screen.getByLabelText('Collapse all'));
    // 'root' and 'n1' are parents; 'n2' is a leaf
    expect(new Set(useMindmapUi.getState().collapsed['map-1'])).toEqual(new Set(['root', 'n1']));

    await user.click(screen.getByLabelText('Expand all'));
    expect(useMindmapUi.getState().collapsed['map-1']).toBeUndefined();
  });
});

describe('MindmapStyleToolbar — canvas background', () => {
  it('applies a preset background and clears it back to the theme', async () => {
    const user = userEvent.setup();
    renderBar(node(), '#ffffff');
    await user.click(screen.getByLabelText('Canvas background'));

    await user.click(screen.getByLabelText('White'));
    expect(mockSetBackground).toHaveBeenCalledWith('map-1', '#ffffff');

    await user.click(screen.getByLabelText('Theme default'));
    expect(mockSetBackground).toHaveBeenCalledWith('map-1', null);
  });

  it('takes a typed hex, and ignores it until it is valid', async () => {
    const user = userEvent.setup();
    renderBar(node(), undefined);
    await user.click(screen.getByLabelText('Canvas background'));
    const hex = screen.getByLabelText('Custom hex');

    await user.clear(hex);
    await user.type(hex, '#12');
    expect(mockSetBackground).not.toHaveBeenCalled();

    await user.type(hex, '34ab');
    expect(mockSetBackground).toHaveBeenCalledWith('map-1', '#1234ab');
  });
});

describe('MindmapStyleToolbar — advanced colours', () => {
  it('renders the popover outside the toolbar, which clips its children', async () => {
    const user = userEvent.setup();
    const { container } = renderBar(node());
    await user.click(screen.getByLabelText('Advanced colours'));

    const popover = screen.getByRole('dialog', { name: 'Advanced colours' });
    const bar = container.firstElementChild!;
    expect(bar.className).toContain('overflow-x-auto');
    expect(bar.contains(popover)).toBe(false);
    expect(document.body.contains(popover)).toBe(true);
  });

  it('the trigger closes the popover again instead of re-opening it', async () => {
    const user = userEvent.setup();
    renderBar(node());
    const trigger = screen.getByLabelText('Advanced colours');
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('writes one part at a time, by picker or by typed hex', async () => {
    const user = userEvent.setup();
    renderBar(node({ palette: 'sky' }));
    await user.click(screen.getByLabelText('Advanced colours'));

    fireEvent.change(screen.getByLabelText('Border'), { target: { value: '#00ff00' } });
    expect(mockUpdateStyle).toHaveBeenCalledWith('n1', { colorBorder: '#00ff00' });

    const hex = screen.getByLabelText('Text hex');
    await user.clear(hex);
    await user.type(hex, '#AABBCC');
    expect(mockUpdateStyle).toHaveBeenCalledWith('n1', { colorFg: '#aabbcc' });
  });

  it('offers "clear" only for parts that carry a custom colour', async () => {
    const user = userEvent.setup();
    renderBar(node({ colorFg: '#111111' }));
    await user.click(screen.getByLabelText('Advanced colours'));
    expect(screen.getAllByText('clear')).toHaveLength(1);
    await user.click(screen.getByText('clear'));
    expect(mockUpdateStyle).toHaveBeenCalledWith('n1', { colorFg: null });
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderBar(node());
    await user.click(screen.getByLabelText('Advanced colours'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('MindmapStyleToolbar — saved presets', () => {
  it('saves the node\'s colours as a reusable preset that survives a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderBar(node({ colorBg: '#102030', colorFg: '#ffffff', colorBorder: '#405060' }));
    await user.click(screen.getByLabelText('Advanced colours'));
    await user.type(screen.getByLabelText('Preset name'), 'Corporate');
    await user.click(screen.getByText('Save preset'));

    expect(useMindmapUi.getState().customPalettes).toMatchObject([
      { name: 'Corporate', bg: '#102030', fg: '#ffffff', border: '#405060' },
    ]);
    expect(localStorage.getItem('gtd25-mindmap-ui')).toContain('Corporate');

    unmount();
    renderBar(node());
    expect(screen.getByLabelText('Corporate')).toBeInTheDocument();
  });

  it('applies a saved preset as literal colours, so it travels with the node', async () => {
    const user = userEvent.setup();
    useMindmapUi.setState({
      customPalettes: [{ id: 'c1', name: 'Brand', bg: '#001122', fg: '#ffffff', border: '#334455' }],
    });
    renderBar(node());
    await user.click(screen.getByLabelText('Brand'));
    expect(mockUpdateStyle).toHaveBeenCalledWith('n1', {
      palette: null, colorBg: '#001122', colorFg: '#ffffff', colorBorder: '#334455',
    });
  });

  it('deletes a saved preset', async () => {
    const user = userEvent.setup();
    useMindmapUi.setState({
      customPalettes: [{ id: 'c1', name: 'Brand', bg: '#001122', fg: '#ffffff', border: '#334455' }],
    });
    renderBar(node());
    await user.click(screen.getByLabelText('Advanced colours'));
    await user.click(screen.getByLabelText('Delete preset Brand'));
    expect(useMindmapUi.getState().customPalettes).toEqual([]);
  });
});
