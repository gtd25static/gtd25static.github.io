// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import type { MindmapNode } from '../../db/models';

const mockUseNodes = vi.fn<() => MindmapNode[]>(() => []);
const mockCreateNode = vi.fn(async () => undefined as MindmapNode | undefined);
const mockUpdateLabel = vi.fn(async () => true);
const mockReparent = vi.fn(async () => true);
const mockDeleteSubtree = vi.fn(async () => {});

vi.mock('../../hooks/use-mindmaps', () => ({
  useMindmapNodes: () => mockUseNodes(),
  createMindmapNode: (...a: unknown[]) => (mockCreateNode as (...x: unknown[]) => unknown)(...a),
  updateMindmapNodeLabel: (...a: unknown[]) => (mockUpdateLabel as (...x: unknown[]) => unknown)(...a),
  reparentMindmapNode: (...a: unknown[]) => (mockReparent as (...x: unknown[]) => unknown)(...a),
  deleteMindmapNodeSubtree: (...a: unknown[]) => (mockDeleteSubtree as (...x: unknown[]) => unknown)(...a),
}));

import { MindmapCanvas } from '../../components/mindmaps/MindmapCanvas';
import { useMindmapUi } from '../../stores/mindmap-ui';

function node(id: string, overrides: Partial<MindmapNode> = {}): MindmapNode {
  return { id, mapId: 'map-1', label: id, order: 0, createdAt: 1, updatedAt: 1, ...overrides };
}

// testing-library's getByTitle doesn't match SVG <title> nested in <g> — query directly.
function actionButton(label: string): Element | undefined {
  return [...document.querySelectorAll('title')].find((t) => t.textContent === label);
}

function nodeEl(id: string): HTMLElement {
  const el = document.querySelector(`[data-mindmap-node="${id}"]`);
  if (!el) throw new Error(`node ${id} not rendered`);
  return el as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem('gtd25-mindmap-ui');
  useMindmapUi.setState({ collapsed: {} });
  mockUseNodes.mockReturnValue([
    node('root', { label: 'Root topic' }),
    node('a', { parentId: 'root', label: 'Child A' }),
    node('b', { parentId: 'root', label: 'Child B', order: 1 }),
    node('a1', { parentId: 'a', label: 'Grandchild' }),
  ]);
});

describe('MindmapCanvas', () => {
  it('renders every visible node and the connecting edges', () => {
    const { container } = render(<MindmapCanvas mapId="map-1" />);
    expect(screen.getByText('Root topic')).toBeInTheDocument();
    expect(screen.getByText('Child A')).toBeInTheDocument();
    expect(screen.getByText('Grandchild')).toBeInTheDocument();
    // 3 edges for 4 nodes in a tree
    expect(container.querySelectorAll('path[d^="M "]').length).toBeGreaterThanOrEqual(3);
  });

  it('selecting a node shows its action buttons', async () => {
    const user = userEvent.setup();
    render(<MindmapCanvas mapId="map-1" />);
    await user.click(nodeEl('a'));
    expect(actionButton('Add child (Tab)')).toBeDefined();
    expect(actionButton('Add sibling (Enter)')).toBeDefined();
    expect(actionButton('Delete (Del)')).toBeDefined();
  });

  it('the root shows no sibling/delete actions', async () => {
    const user = userEvent.setup();
    render(<MindmapCanvas mapId="map-1" />);
    await user.click(nodeEl('root'));
    expect(actionButton('Add child (Tab)')).toBeDefined();
    expect(actionButton('Add sibling (Enter)')).toBeUndefined();
    expect(actionButton('Delete (Del)')).toBeUndefined();
  });

  it('collapsing a node hides its subtree', () => {
    render(<MindmapCanvas mapId="map-1" />);
    expect(screen.getByText('Grandchild')).toBeInTheDocument();
    act(() => useMindmapUi.getState().toggleCollapsed('map-1', 'a'));
    // Grandchild leaves the layout (it may stay mounted invisibly for measuring —
    // assert it is not part of any laid-out, visible foreignObject)
    const el = document.querySelector('[data-mindmap-node="a1"]');
    // (closest('foreignObject') doesn't match SVG camelCase tags in jsdom)
    const fo = el?.parentElement;
    expect(fo?.getAttribute('style') ?? '').toContain('opacity: 0');
  });

  it('double-click starts inline edit; Enter commits the new label', async () => {
    const user = userEvent.setup();
    render(<MindmapCanvas mapId="map-1" />);
    await user.dblClick(nodeEl('a'));
    const textarea = await screen.findByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Renamed node{Enter}');
    await waitFor(() => expect(mockUpdateLabel).toHaveBeenCalledWith('a', 'Renamed node'));
  });

  it('Escape cancels the edit without saving', async () => {
    const user = userEvent.setup();
    render(<MindmapCanvas mapId="map-1" />);
    await user.dblClick(nodeEl('a'));
    const textarea = await screen.findByRole('textbox');
    await user.type(textarea, 'draft{Escape}');
    expect(mockUpdateLabel).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('Tab creates a child of the selected node', async () => {
    const user = userEvent.setup();
    mockCreateNode.mockResolvedValue(node('new-child', { parentId: 'a' }));
    render(<MindmapCanvas mapId="map-1" />);
    await user.click(nodeEl('a'));
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: 'Tab' });
    await waitFor(() => expect(mockCreateNode).toHaveBeenCalledWith('map-1', 'a'));
  });

  it('Enter creates a sibling (not for the root)', async () => {
    const user = userEvent.setup();
    mockCreateNode.mockResolvedValue(node('new-sib', { parentId: 'root' }));
    render(<MindmapCanvas mapId="map-1" />);
    await user.click(nodeEl('a'));
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: 'Enter' });
    await waitFor(() => expect(mockCreateNode).toHaveBeenCalledWith('map-1', 'root'));

    mockCreateNode.mockClear();
    await user.click(nodeEl('root'));
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: 'Enter' });
    expect(mockCreateNode).not.toHaveBeenCalled();
  });

  it('Delete on a leaf deletes without confirm; root is never deletable', async () => {
    const user = userEvent.setup();
    render(<MindmapCanvas mapId="map-1" />);
    await user.click(nodeEl('b'));
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: 'Delete' });
    await waitFor(() => expect(mockDeleteSubtree).toHaveBeenCalledWith('b'));

    mockDeleteSubtree.mockClear();
    await user.click(nodeEl('root'));
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: 'Delete' });
    expect(mockDeleteSubtree).not.toHaveBeenCalled();
  });

  it('arrow keys navigate the tree', async () => {
    const user = userEvent.setup();
    render(<MindmapCanvas mapId="map-1" />);
    const canvas = screen.getByTestId('mindmap-canvas');
    await user.click(nodeEl('a'));
    fireEvent.keyDown(canvas, { key: 'ArrowRight' }); // into Grandchild
    fireEvent.keyDown(canvas, { key: 'ArrowLeft' });  // back to a
    fireEvent.keyDown(canvas, { key: 'ArrowDown' });  // sibling b
    // b selected → has delete button (root doesn't)
    expect(actionButton('Delete (Del)')).toBeDefined();
    fireEvent.keyDown(canvas, { key: 'Tab' });
    await waitFor(() => expect(mockCreateNode).toHaveBeenCalledWith('map-1', 'b'));
  });

  it('renders markdown in labels as elements, never HTML', () => {
    mockUseNodes.mockReturnValue([
      node('root', { label: 'has **bold** and <img src=x onerror=alert(1)>' }),
    ]);
    const { container } = render(<MindmapCanvas mapId="map-1" />);
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    // The HTML-looking text stays literal text — no img element is created
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
  });
});
