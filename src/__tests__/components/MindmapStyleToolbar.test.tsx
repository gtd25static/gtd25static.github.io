// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import type { MindmapNode } from '../../db/models';

const mockUpdateStyle = vi.fn(async () => true);
vi.mock('../../hooks/use-mindmaps', () => ({
  updateMindmapNodeStyle: (...a: unknown[]) => (mockUpdateStyle as (...x: unknown[]) => unknown)(...a),
}));

import { MindmapStyleToolbar } from '../../components/mindmaps/MindmapStyleToolbar';
import { useMindmapUi } from '../../stores/mindmap-ui';

function node(overrides: Partial<MindmapNode> = {}): MindmapNode {
  return {
    id: 'n1', mapId: 'map-1', parentId: 'root', label: 'A node',
    order: 0, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useMindmapUi.setState({ selectedNodeId: 'n1', stylePreview: null });
});

describe('MindmapStyleToolbar', () => {
  it('offers the three shapes and marks the current one', () => {
    render(<MindmapStyleToolbar node={node({ shape: 'circle' })} isRoot={false} />);
    expect(screen.getByLabelText('Circle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Rounded rectangle')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Decision diamond')).toBeInTheDocument();
  });

  it('applies a shape', async () => {
    const user = userEvent.setup();
    render(<MindmapStyleToolbar node={node()} isRoot={false} />);
    await user.click(screen.getByLabelText('Decision diamond'));
    expect(mockUpdateStyle).toHaveBeenCalledWith('n1', { shape: 'diamond' });
  });

  it('offers five presets plus "no colour", and applying one clears any custom colours', async () => {
    const user = userEvent.setup();
    render(<MindmapStyleToolbar node={node({ colorBg: '#123456' })} isRoot={false} />);
    expect(screen.getByLabelText('No colour')).toBeInTheDocument();
    for (const name of ['Sky', 'Mint', 'Amber', 'Rose', 'Slate']) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }
    await user.click(screen.getByLabelText('Mint'));
    expect(mockUpdateStyle).toHaveBeenCalledWith('n1', {
      palette: 'mint', colorBg: null, colorFg: null, colorBorder: null,
    });
  });

  it('previews a preset on hover and takes it back on leave', () => {
    render(<MindmapStyleToolbar node={node()} isRoot={false} />);
    const rose = screen.getByLabelText('Rose');

    fireEvent.pointerEnter(rose, { pointerType: 'mouse' });
    expect(useMindmapUi.getState().stylePreview).toMatchObject({ palette: 'rose' });

    fireEvent.pointerLeave(rose);
    expect(useMindmapUi.getState().stylePreview).toBeNull();
  });

  it('does not preview on touch (there is no hover to take back)', () => {
    render(<MindmapStyleToolbar node={node()} isRoot={false} />);
    fireEvent.pointerEnter(screen.getByLabelText('Rose'), { pointerType: 'touch' });
    expect(useMindmapUi.getState().stylePreview).toBeNull();
  });

  it('drops the preview when the toolbar goes away', () => {
    const { unmount } = render(<MindmapStyleToolbar node={node()} isRoot={false} />);
    fireEvent.pointerEnter(screen.getByLabelText('Sky'), { pointerType: 'mouse' });
    expect(useMindmapUi.getState().stylePreview).not.toBeNull();
    unmount();
    expect(useMindmapUi.getState().stylePreview).toBeNull();
  });

  it('opens the advanced popover and writes one part at a time', async () => {
    const user = userEvent.setup();
    render(<MindmapStyleToolbar node={node({ palette: 'sky' })} isRoot={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('Advanced colours'));
    const popover = screen.getByRole('dialog', { name: 'Advanced colours' });
    expect(popover).toBeInTheDocument();

    const border = screen.getByText('Border').parentElement!.querySelector('input[type="color"]')!;
    fireEvent.change(border, { target: { value: '#00ff00' } });
    expect(mockUpdateStyle).toHaveBeenCalledWith('n1', { colorBorder: '#00ff00' });
  });

  it('offers "clear" only for parts that carry a custom colour', async () => {
    const user = userEvent.setup();
    render(<MindmapStyleToolbar node={node({ colorFg: '#111111' })} isRoot={false} />);
    await user.click(screen.getByLabelText('Advanced colours'));
    expect(screen.getAllByText('clear')).toHaveLength(1);

    await user.click(screen.getByText('clear'));
    expect(mockUpdateStyle).toHaveBeenCalledWith('n1', { colorFg: null });
  });

  it('closes the advanced popover on Escape', async () => {
    const user = userEvent.setup();
    render(<MindmapStyleToolbar node={node()} isRoot={false} />);
    await user.click(screen.getByLabelText('Advanced colours'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
