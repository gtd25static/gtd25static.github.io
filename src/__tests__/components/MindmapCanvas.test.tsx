// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import type { MindmapNode } from '../../db/models';

const mockUseNodes = vi.fn<() => MindmapNode[]>(() => []);
const mockCreateNode = vi.fn(async () => undefined as MindmapNode | undefined);
const mockUpdateLabel = vi.fn(async () => true);
const mockReparent = vi.fn(async () => true);
const mockMoveBeside = vi.fn(async () => true);
const mockDeleteSubtree = vi.fn(async () => [] as string[]);
const mockRestoreSubtree = vi.fn(async () => {});
const mockToast = vi.fn();

vi.mock('../../components/ui/Toast', () => ({
  toast: (...a: unknown[]) => mockToast(...a),
}));

vi.mock('../../hooks/use-mindmaps', () => ({
  useMindmapNodes: () => mockUseNodes(),
  createMindmapNode: (...a: unknown[]) => (mockCreateNode as (...x: unknown[]) => unknown)(...a),
  updateMindmapNodeLabel: (...a: unknown[]) => (mockUpdateLabel as (...x: unknown[]) => unknown)(...a),
  reparentMindmapNode: (...a: unknown[]) => (mockReparent as (...x: unknown[]) => unknown)(...a),
  moveMindmapNodeBeside: (...a: unknown[]) => (mockMoveBeside as (...x: unknown[]) => unknown)(...a),
  deleteMindmapNodeSubtree: (...a: unknown[]) => (mockDeleteSubtree as (...x: unknown[]) => unknown)(...a),
  restoreMindmapNodeSubtree: (...a: unknown[]) => (mockRestoreSubtree as (...x: unknown[]) => unknown)(...a),
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

// The canvas resolves hover from pointer coordinates. jsdom reports an all-zero
// getBoundingClientRect for the <svg>, so client == world + the initial {40,40}
// pan; node boxes are read straight off their <foreignObject>.
function nodeBox(id: string): { x: number; y: number; w: number; h: number } {
  const fo = nodeEl(id).parentElement!;
  const num = (a: string) => Number(fo.getAttribute(a) ?? 0);
  return { x: num('x'), y: num('y'), w: num('width'), h: num('height') };
}

function movePointerOverNode(id: string, dx = 0, dy = 0) {
  const box = nodeBox(id);
  fireEvent.pointerMove(document.querySelector('svg')!, {
    pointerType: 'mouse',
    clientX: box.x + box.w / 2 + 40 + dx,
    clientY: box.y + box.h / 2 + 40 + dy,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteSubtree.mockResolvedValue([]);
  localStorage.removeItem('gtd25-mindmap-ui');
  useMindmapUi.setState({ collapsed: {}, selectedNodeId: null, stylePreview: null, mapSearch: null });
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

  it('hovering a node shows its actions without clicking, and they follow the mouse', async () => {
    render(<MindmapCanvas mapId="map-1" />);
    expect(actionButton('Add child (Tab)')).toBeUndefined();

    movePointerOverNode('a');
    expect(actionButton('Add child (Tab)')).toBeDefined();
    fireEvent.click(actionButton('Add child (Tab)')!.parentElement!);
    await waitFor(() => expect(mockCreateNode).toHaveBeenCalledWith('map-1', 'a', undefined, undefined));

    mockCreateNode.mockClear();
    movePointerOverNode('b');
    fireEvent.click(actionButton('Add child (Tab)')!.parentElement!);
    await waitFor(() => expect(mockCreateNode).toHaveBeenCalledWith('map-1', 'b', undefined, undefined));
  });

  it('keeps the actions alive while the pointer travels off the box onto a button', async () => {
    render(<MindmapCanvas mapId="map-1" />);
    const a = nodeBox('a');
    movePointerOverNode('a');
    // The delete button floats above/right of the box, past the grace band
    fireEvent.pointerMove(document.querySelector('svg')!, {
      pointerType: 'mouse',
      clientX: a.x + a.w + 14 + 40,
      clientY: a.y - 16 + 40,
    });
    expect(actionButton('Delete (Del)')).toBeDefined();
    // …and the actions still belong to a, not to whatever is underneath
    fireEvent.click(actionButton('Add child (Tab)')!.parentElement!);
    await waitFor(() => expect(mockCreateNode).toHaveBeenCalledWith('map-1', 'a', undefined, undefined));
  });

  it('leaving the canvas hides the hover actions, and touch never triggers them', () => {
    render(<MindmapCanvas mapId="map-1" />);
    movePointerOverNode('a');
    expect(actionButton('Add child (Tab)')).toBeDefined();
    fireEvent.pointerLeave(document.querySelector('svg')!);
    expect(actionButton('Add child (Tab)')).toBeUndefined();

    const box = nodeBox('a');
    fireEvent.pointerMove(document.querySelector('svg')!, {
      pointerType: 'touch',
      clientX: box.x + box.w / 2 + 40,
      clientY: box.y + box.h / 2 + 40,
    });
    expect(actionButton('Add child (Tab)')).toBeUndefined();
  });

  it('the root shows no sibling/delete actions', async () => {
    const user = userEvent.setup();
    render(<MindmapCanvas mapId="map-1" />);
    await user.click(nodeEl('root'));
    expect(actionButton('Add child (Tab)')).toBeDefined();
    expect(actionButton('Add sibling (Enter)')).toBeUndefined();
    expect(actionButton('Delete (Del)')).toBeUndefined();
  });

  it('collapsing a node pins it in place, so the diagram does not jump', async () => {
    const user = userEvent.setup();
    // A has three children, so collapsing it genuinely re-flows the layout —
    // without the pin, A itself would shift up into the freed space.
    mockUseNodes.mockReturnValue([
      node('root', { label: 'Root' }),
      node('A', { parentId: 'root' }),
      node('B', { parentId: 'root', order: 1 }),
      node('A1', { parentId: 'A' }),
      node('A2', { parentId: 'A', order: 1 }),
      node('A3', { parentId: 'A', order: 2 }),
    ]);
    render(<MindmapCanvas mapId="map-1" />);
    await user.click(nodeEl('A'));
    const aBefore = nodeBox('A').y;
    const bBefore = nodeBox('B').y;
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: ' ' });
    // The toggled node keeps its exact position; the rest reflows around it.
    expect(nodeBox('A').y).toBe(aBefore);
    expect(nodeBox('B').y).not.toBe(bBefore);
  });

  it('collapsing a node hides its subtree', () => {
    render(<MindmapCanvas mapId="map-1" />);
    expect(screen.getByText('Grandchild')).toBeInTheDocument();
    act(() => useMindmapUi.getState().toggleCollapsed('map-1', 'a'));
    // Grandchild leaves the layout (it may stay mounted invisibly for measuring —
    // assert it is not part of any laid-out, visible foreignObject)
    const el = document.querySelector('[data-mindmap-node="a1"]');
    // The node's <g> wrapper carries the hidden-while-measuring style
    // (closest() doesn't match SVG camelCase tags in jsdom, hence the walk up)
    const group = el?.parentElement?.parentElement;
    expect(group?.getAttribute('style') ?? '').toContain('opacity: 0');
  });

  // Double-click is detected from our own pointer events (the svg's pointer
  // capture retargets the DOM's dblclick to the <svg>), so exercise it that way.
  function tapNode(id: string, clientX = 0, clientY = 0) {
    fireEvent.pointerDown(nodeEl(id), { pointerId: 1, clientX, clientY });
    fireEvent.pointerUp(nodeEl(id), { pointerId: 1, clientX, clientY });
  }

  it('two taps on a node open the inline editor; one tap only selects', async () => {
    render(<MindmapCanvas mapId="map-1" />);
    tapNode('a');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    tapNode('a');
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
  });

  it('does not treat slow, far-apart or different-node taps as a double-click', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      render(<MindmapCanvas mapId="map-1" />);

      now.mockReturnValue(1000);
      tapNode('a');
      now.mockReturnValue(1600); // 600ms later — past the double-tap window
      tapNode('a');
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

      now.mockReturnValue(1700);
      tapNode('a', 0, 0);
      now.mockReturnValue(1750);
      tapNode('a', 0, 40); // same node, but the pointer moved a long way
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

      now.mockReturnValue(1800);
      tapNode('a');
      now.mockReturnValue(1850);
      tapNode('b');
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    } finally {
      now.mockRestore();
    }
  });

  it('pressing outside the open editor commits and leaves edit mode', async () => {
    const user = userEvent.setup();
    render(<MindmapCanvas mapId="map-1" />);
    tapNode('a');
    tapNode('a');
    const textarea = await screen.findByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Edited elsewhere');

    // A press that lands on something which never takes focus (so no blur)
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(mockUpdateLabel).toHaveBeenCalledWith('a', 'Edited elsewhere'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
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

  // Regression: leaving edit mode unmounts the focused textarea, which dropped
  // focus to <body> — so after Tab → type → Enter the next Enter/Tab/F2/arrow
  // did nothing until the canvas was clicked again.
  it('Enter (commit) and Escape (cancel) hand focus back to the canvas, so the next key works', async () => {
    const user = userEvent.setup();
    render(<MindmapCanvas mapId="map-1" />);
    await user.dblClick(nodeEl('a'));
    const textarea = await screen.findByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Renamed{Enter}');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('mindmap-canvas')).toHaveFocus();
    expect(mockUpdateLabel).toHaveBeenCalledTimes(1); // the refocus blur must not commit twice

    await user.keyboard('{F2}');
    const again = await screen.findByRole('textbox');
    await user.type(again, 'draft{Escape}');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('mindmap-canvas')).toHaveFocus();
    expect(mockUpdateLabel).toHaveBeenCalledTimes(1); // cancel saved nothing
  });

  it('a commit caused by focus moving elsewhere does not steal focus back', async () => {
    const user = userEvent.setup();
    render(<><input placeholder="elsewhere" /><MindmapCanvas mapId="map-1" /></>);
    const canvas = within(screen.getByTestId('mindmap-canvas'));
    await user.dblClick(nodeEl('a'));
    const textarea = await canvas.findByRole('textbox');
    await user.type(textarea, 'x');
    act(() => { screen.getByPlaceholderText('elsewhere').focus(); });
    await waitFor(() => expect(canvas.queryByRole('textbox')).not.toBeInTheDocument());
    expect(mockUpdateLabel).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('elsewhere')).toHaveFocus();
  });

  it('Tab creates a child of the selected node', async () => {
    const user = userEvent.setup();
    mockCreateNode.mockResolvedValue(node('new-child', { parentId: 'a' }));
    render(<MindmapCanvas mapId="map-1" />);
    await user.click(nodeEl('a'));
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: 'Tab' });
    await waitFor(() => expect(mockCreateNode).toHaveBeenCalledWith('map-1', 'a', undefined, undefined));
  });

  it('Enter creates a sibling (not for the root)', async () => {
    const user = userEvent.setup();
    mockCreateNode.mockResolvedValue(node('new-sib', { parentId: 'root' }));
    render(<MindmapCanvas mapId="map-1" />);
    await user.click(nodeEl('a'));
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: 'Enter' });
    await waitFor(() => expect(mockCreateNode).toHaveBeenCalledWith('map-1', 'root', undefined, undefined));

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

  it('deleting offers an undo toast that restores exactly the deleted nodes', async () => {
    const user = userEvent.setup();
    mockDeleteSubtree.mockResolvedValue(['b']);
    render(<MindmapCanvas mapId="map-1" />);
    await user.click(nodeEl('b'));
    fireEvent.click(actionButton('Delete (Del)')!.parentElement!);

    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    const [message, type, onUndo, durationMs] = mockToast.mock.calls[0] as [string, string, () => void, number];
    expect(message).toBe('Node deleted');
    expect(type).toBe('info');
    expect(durationMs).toBeGreaterThanOrEqual(5000);

    onUndo();
    expect(mockRestoreSubtree).toHaveBeenCalledWith(['b']);
  });

  it('the undo toast counts the whole deleted subtree, and stays silent when nothing was deleted', async () => {
    const user = userEvent.setup();
    mockDeleteSubtree.mockResolvedValue(['b', 'b-child']);
    render(<MindmapCanvas mapId="map-1" />);
    await user.click(nodeEl('b'));
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: 'Delete' });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('2 nodes deleted', 'info', expect.any(Function), expect.any(Number)));

    // Nothing stamped (already gone / raced with another device) → no undo offered.
    // A different node, because two quick clicks on the same one open the editor.
    mockToast.mockClear();
    mockDeleteSubtree.mockResolvedValue([]);
    await user.click(nodeEl('a1'));
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: 'Delete' });
    await waitFor(() => expect(mockDeleteSubtree).toHaveBeenCalledTimes(2));
    expect(mockToast).not.toHaveBeenCalled();
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
    await waitFor(() => expect(mockCreateNode).toHaveBeenCalledWith('map-1', 'b', undefined, undefined));
  });

  describe('dragging a node', () => {
    // Press on `id`, move past the drag threshold, then hover `fy` of the way
    // down `targetId`'s box (client = world + the initial {40,40} pan).
    function dragOnto(id: string, targetId: string, fy: number) {
      const svg = document.querySelector('svg')!;
      const from = nodeBox(id);
      const to = nodeBox(targetId);
      fireEvent.pointerDown(nodeEl(id), { pointerId: 1, clientX: from.x + 40 + 10, clientY: from.y + 40 + 10 });
      fireEvent.pointerMove(svg, { pointerId: 1, clientX: from.x + 40 + 30, clientY: from.y + 40 + 30 });
      fireEvent.pointerMove(svg, { pointerId: 1, clientX: to.x + 40 + to.w / 2, clientY: to.y + 40 + to.h * fy });
    }
    const release = () => fireEvent.pointerUp(document.querySelector('svg')!, { pointerId: 1 });

    it('onto the top edge of a sibling places it before, with an insertion line', () => {
      render(<MindmapCanvas mapId="map-1" />);
      dragOnto('b', 'a', 0.1);
      expect(screen.getByTestId('mindmap-drop-line')).toBeInTheDocument();
      release();
      expect(mockMoveBeside).toHaveBeenCalledWith('b', 'a', 'before');
      expect(mockReparent).not.toHaveBeenCalled();
      expect(screen.queryByTestId('mindmap-drop-line')).toBeNull();
    });

    it('onto the bottom edge places it after', () => {
      render(<MindmapCanvas mapId="map-1" />);
      dragOnto('a', 'b', 0.9);
      release();
      expect(mockMoveBeside).toHaveBeenCalledWith('a', 'b', 'after');
    });

    it('onto the middle still re-parents, without the line', () => {
      render(<MindmapCanvas mapId="map-1" />);
      dragOnto('b', 'a1', 0.5);
      expect(screen.queryByTestId('mindmap-drop-line')).toBeNull();
      release();
      expect(mockReparent).toHaveBeenCalledWith('b', 'a1');
      expect(mockMoveBeside).not.toHaveBeenCalled();
    });

    it('never drops into its own subtree', () => {
      render(<MindmapCanvas mapId="map-1" />);
      dragOnto('a', 'a1', 0.1);
      expect(screen.queryByTestId('mindmap-drop-line')).toBeNull();
      release();
      expect(mockMoveBeside).not.toHaveBeenCalled();
      expect(mockReparent).not.toHaveBeenCalled();
    });
  });

  // Motion stays off until the map has been measured and fitted — which never
  // happens in jsdom (offsetWidth is 0), so every other test runs unanimated.
  // Faking the measurement turns it on and exercises the enter/exit wiring.
  it('with motion on, the actions close instead of vanishing and collapsed nodes leave a ghost', async () => {
    const measured = { configurable: true, value: 120 };
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', measured);
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 36 });
    try {
      const user = userEvent.setup();
      render(<MindmapCanvas mapId="map-1" />);
      await user.click(nodeEl('a'));
      expect(actionButton('Add child (Tab)')).toBeDefined();

      // Deselect: the group is kept, inert, to animate out
      fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: 'Escape' });
      await waitFor(() => expect(document.querySelector('.mm-actions-closed')).toBeTruthy());
      expect(document.querySelector('.mm-actions-closed')).toHaveAttribute('aria-hidden', 'true');

      // Collapsing 'a' hides 'a1' — it lingers as a ghost, then goes
      act(() => useMindmapUi.getState().toggleCollapsed('map-1', 'a'));
      // The ghost takes over on the first animation frame and lives EXIT_MS,
      // so sample faster than waitFor's default 50ms.
      await waitFor(() => {
        const ghost = document.querySelector('.mm-node-out');
        expect(ghost).toHaveTextContent('Grandchild');
        expect(ghost?.getAttribute('data-mindmap-node')).toBeNull(); // not a hit target
      }, { interval: 5 });
      await waitFor(() => expect(document.querySelector('.mm-node-out')).toBeNull(), { interval: 5 });
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
    }
  });

  // Regression: on a large map the node measurements land in SEVERAL commits,
  // re-firing the fit effect before the motion-arming animation frame has run.
  // The arming must survive that churn — it used to be cancelled without a
  // reschedule, leaving motionReady false forever: no glide, no ghosts, no
  // enter fades, on exactly the maps big enough to measure in waves.
  it('arms motion even when measurements land in several waves (large maps)', () => {
    let width = 120;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => width });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 36 });
    // Manual rAF queue: nothing fires until flushed, so the second measurement
    // wave provably lands BEFORE the arming frame — the race, deterministically.
    const rafQueue = new Map<number, FrameRequestCallback>();
    let rafId = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafQueue.set(++rafId, cb);
      return rafId;
    });
    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      rafQueue.delete(id);
    });
    const flushRaf = () => act(() => {
      const pending = [...rafQueue.values()];
      rafQueue.clear();
      for (const cb of pending) cb(performance.now());
    });
    try {
      render(<MindmapCanvas mapId="map-1" />);
      // Wave 2: every node re-measures wider before any animation frame fired.
      width = 160;
      act(() => useMindmapUi.getState().setSelectedNodeId('a')); // any re-render
      flushRaf(); // the (re-scheduled) arming frame → motionReady
      flushRaf();
      // With motion armed, collapsing leaves the hidden subtree as a ghost.
      act(() => useMindmapUi.getState().toggleCollapsed('map-1', 'a'));
      flushRaf(); // first glide tick renders the exit ghost
      expect(document.querySelector('.mm-node-out')).toHaveTextContent('Grandchild');
    } finally {
      rafSpy.mockRestore();
      cafSpy.mockRestore();
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
    }
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

describe('MindmapCanvas — the canvas colour', () => {
  // Validated on write only, so a value from a backup import or a tampered local
  // DB reached the style attribute as it was (threat-model review, batch 2).
  it('applies a #rrggbb colour', () => {
    render(<MindmapCanvas mapId="map-1" background="#112233" />);
    expect(screen.getByTestId('mindmap-canvas').style.background).not.toBe('');
  });

  it('ignores anything else', () => {
    render(<MindmapCanvas mapId="map-1" background="url(data:image/png;base64,AAAA)" />);
    expect(screen.getByTestId('mindmap-canvas').style.background).toBe('');
  });
});

describe('MindmapCanvas — "Collapse all" brings the root back into view', () => {
  // A big expanded map, panned around, then folded from the toolbar: only the
  // root is left, wherever the big layout had put it — often off screen.
  const W = 800;
  const H = 600;
  let rectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Only the <svg> and its container: node boxes keep measuring as before.
    rectSpy = vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { x: 0, y: 0, left: 0, top: 0, right: W, bottom: H, width: W, height: H, toJSON: () => ({}) } as DOMRect);
  });
  afterEach(() => rectSpy.mockRestore());

  function viewport() {
    const g = document.querySelector('svg > g')!.getAttribute('transform')!;
    const [tx, ty, k] = g.match(/-?[\d.]+(?:e-?\d+)?/g)!.map(Number);
    return { tx, ty, k };
  }
  function rootOnScreen() {
    const { tx, ty, k } = viewport();
    const b = nodeBox('root');
    return { x: (b.x + b.w / 2) * k + tx, y: (b.y + b.h / 2) * k + ty };
  }
  function panBy(dx: number, dy: number) {
    const svg = document.querySelector('svg')!;
    fireEvent.pointerDown(svg, { pointerId: 7, pointerType: 'mouse', clientX: 400, clientY: 300 });
    fireEvent.pointerMove(svg, { pointerId: 7, pointerType: 'mouse', clientX: 400 + dx, clientY: 300 + dy });
    fireEvent.pointerUp(svg, { pointerId: 7, pointerType: 'mouse', clientX: 400 + dx, clientY: 300 + dy });
  }

  it('centres the root after the whole map is collapsed', async () => {
    render(<MindmapCanvas mapId="map-1" />);
    panBy(-3000, -2000);
    expect(rootOnScreen().x).toBeLessThan(0);

    act(() => useMindmapUi.getState().collapseAll('map-1', ['root', 'a']));

    await waitFor(() => {
      const p = rootOnScreen();
      expect(Math.abs(p.x - W / 2)).toBeLessThan(2);
      expect(Math.abs(p.y - H / 2)).toBeLessThan(2);
    }, { timeout: 1500 });
  });

  it('collapsing one node still leaves the view where it is', async () => {
    render(<MindmapCanvas mapId="map-1" />);
    panBy(-3000, -2000);
    const before = viewport();
    act(() => useMindmapUi.getState().toggleCollapsed('map-1', 'a'));
    await new Promise((r) => setTimeout(r, 50));
    expect(viewport()).toEqual(before);
  });

  it('a "Collapse all" of another map does not move this one', async () => {
    render(<MindmapCanvas mapId="map-1" />);
    panBy(-3000, -2000);
    const before = viewport();
    act(() => useMindmapUi.getState().collapseAll('map-2', ['x']));
    await new Promise((r) => setTimeout(r, 50));
    expect(viewport()).toEqual(before);
  });
});

describe('MindmapCanvas — search inside the map', () => {
  // Fixture: root › a (Child A) › a1 (Grandchild); root › b (Child B).
  // "child" matches all three of a, a1 ("Grandchild") and b.
  const findBox = () => screen.getByRole('textbox', { name: 'Search this map' });
  // The node's <g> wrapper (two levels up, past the foreignObject).
  const group = (id: string) => nodeEl(id).parentElement!.parentElement!;
  const isHit = (id: string) => group(id).hasAttribute('data-search-hit');
  const isDimmed = (id: string) => group(id).style.opacity === '0.35';
  // Unmeasured nodes stay mounted, invisible, to report a size (jsdom never measures).
  const shown = (id: string) => group(id).style.opacity !== '0';

  async function search(text: string) {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Search this map (Ctrl+F)' }));
    await user.type(findBox(), text);
    return user;
  }

  it('highlights the matches, fades the rest and goes to the first one', async () => {
    render(<MindmapCanvas mapId="map-1" />);
    await search('child b');
    expect(isHit('b')).toBe(true);
    expect(isHit('a')).toBe(false);
    expect(isDimmed('root')).toBe(true);
    expect(isDimmed('a')).toBe(true);
    expect(isDimmed('b')).toBe(false);
    expect(useMindmapUi.getState().selectedNodeId).toBe('b');
    expect(screen.getByText('1/1')).toBeInTheDocument();
  });

  it('Enter / Shift+Enter step through the matches, in reading order, without the canvas keys firing', async () => {
    render(<MindmapCanvas mapId="map-1" />);
    const user = await search('child');
    expect(useMindmapUi.getState().selectedNodeId).toBe('a');
    expect(screen.getByText('1/3')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(useMindmapUi.getState().selectedNodeId).toBe('a1'); // a's child before a's sibling
    await user.keyboard('{Enter}');
    expect(useMindmapUi.getState().selectedNodeId).toBe('b');
    expect(screen.getByText('3/3')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(useMindmapUi.getState().selectedNodeId).toBe('a'); // wraps
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(useMindmapUi.getState().selectedNodeId).toBe('b');
    expect(mockCreateNode).not.toHaveBeenCalled(); // Enter on the canvas adds a sibling
  });

  it('no match: says so, and fades nothing', async () => {
    render(<MindmapCanvas mapId="map-1" />);
    await search('zebra');
    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(isDimmed('root')).toBe(false);
  });

  it('opens a collapsed branch holding a match for the search only, keeping the way to the selected match', async () => {
    useMindmapUi.getState().collapseAll('map-1', ['a']);
    render(<MindmapCanvas mapId="map-1" />);
    expect(shown('a1')).toBe(false);

    const user = await search('grand');
    expect(shown('a1')).toBe(true);
    expect(isHit('a1')).toBe(true);
    expect(useMindmapUi.getState().collapsed['map-1']).toEqual(['a']); // stored state untouched

    // Ending the search with the match selected keeps the way to it open.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Search this map' })).not.toBeInTheDocument();
    expect(useMindmapUi.getState().mapSearch).toBeNull();
    expect(shown('a1')).toBe(true);
    expect(useMindmapUi.getState().collapsed['map-1'] ?? []).toEqual([]);
  });

  it('clearing the search folds back what it opened when the selection is elsewhere', async () => {
    useMindmapUi.getState().collapseAll('map-1', ['a']);
    render(<MindmapCanvas mapId="map-1" />);
    const user = await search('grand');
    expect(shown('a1')).toBe(true);
    act(() => useMindmapUi.getState().setSelectedNodeId('b'));
    await user.clear(findBox());
    expect(shown('a1')).toBe(false);
    expect(useMindmapUi.getState().collapsed['map-1']).toEqual(['a']);
  });

  it('a branch closed again during the search stays closed, until stepping to a match inside it', async () => {
    useMindmapUi.getState().collapseAll('map-1', ['a']);
    render(<MindmapCanvas mapId="map-1" />);
    const user = await search('grand');
    act(() => useMindmapUi.getState().setSelectedNodeId('a'));
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: ' ' }); // collapse 'a'
    expect(shown('a1')).toBe(false);
    expect(useMindmapUi.getState().collapsed['map-1']).toEqual(['a']); // still only the search's business

    await user.click(screen.getByRole('button', { name: 'Next match (Enter)' }));
    expect(shown('a1')).toBe(true);
    expect(useMindmapUi.getState().selectedNodeId).toBe('a1');
  });

  it('collapsing a branch the search did not open is a normal, stored collapse', async () => {
    render(<MindmapCanvas mapId="map-1" />);
    await search('grand');
    act(() => useMindmapUi.getState().setSelectedNodeId('a'));
    fireEvent.keyDown(screen.getByTestId('mindmap-canvas'), { key: ' ' });
    expect(useMindmapUi.getState().collapsed['map-1']).toEqual(['a']);
  });

  it('a map opened with a search (from the browser) shows it, without grabbing focus', () => {
    useMindmapUi.setState({ mapSearch: { mapId: 'map-1', query: 'child' } });
    render(<MindmapCanvas mapId="map-1" />);
    expect(findBox()).toHaveValue('child');
    expect(findBox()).not.toHaveFocus();
    expect(isHit('a')).toBe(true);
  });

  it('once laid out, a map opened with a search selects its first match', async () => {
    // The first fit only happens once nodes are measured — fake it, as the motion tests do.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 120 });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 36 });
    try {
      useMindmapUi.setState({ mapSearch: { mapId: 'map-1', query: 'child b' } });
      render(<MindmapCanvas mapId="map-1" />);
      await waitFor(() => expect(useMindmapUi.getState().selectedNodeId).toBe('b'));
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
    }
  });

  it("another map's search does not apply here", () => {
    useMindmapUi.setState({ mapSearch: { mapId: 'map-2', query: 'child' } });
    render(<MindmapCanvas mapId="map-1" />);
    expect(screen.queryByRole('textbox', { name: 'Search this map' })).not.toBeInTheDocument();
    expect(isHit('a')).toBe(false);
  });

  it('Ctrl+F opens the search and focuses it', async () => {
    render(<MindmapCanvas mapId="map-1" />);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await waitFor(() => expect(findBox()).toHaveFocus());
  });
});
