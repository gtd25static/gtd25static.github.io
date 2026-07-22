// @vitest-environment jsdom
import { render } from '@testing-library/react';
import '../setup-component';
import type { MindmapNode } from '../../db/models';
import { MindmapNodeView } from '../../components/mindmaps/MindmapNodeView';

function node(overrides: Partial<MindmapNode> = {}): MindmapNode {
  return { id: 'n1', mapId: 'm1', parentId: 'root', label: 'Node', order: 0, createdAt: 1, updatedAt: 1, ...overrides };
}

const RECT = { x: 100, y: 40, w: 120, h: 36 };
const noop = () => {};

function renderNode(props: Partial<React.ComponentProps<typeof MindmapNodeView>> = {}) {
  const { container } = render(
    <svg>
      <MindmapNodeView
        node={node()} rect={RECT} selected={false} hovered={false} editing={false}
        isRoot={false} isDragSource={false} isDropTarget={false}
        animateIn={false} onMeasure={noop} onPointerDown={noop} onCommitEdit={noop} onCancelEdit={noop}
        {...props}
      />
    </svg>,
  );
  return container.querySelector('g.mm-node-box') as SVGGElement;
}

describe('MindmapNodeView animation classes', () => {
  it('always carries mm-node-box (the transform-box: fill-box carrier)', () => {
    expect(renderNode()).toBeTruthy();
  });

  it('gets mm-node-in when animateIn is on and it has a rect (create / expand)', () => {
    expect(renderNode({ animateIn: true }).classList.contains('mm-node-in')).toBe(true);
  });

  it('does NOT animate in on the initial, pre-settle mount (animateIn off)', () => {
    const g = renderNode({ animateIn: false });
    expect(g.classList.contains('mm-node-in')).toBe(false);
  });

  it('gets mm-node-out when leaving (collapse / delete ghost)', () => {
    const g = renderNode({ animateIn: false, leaving: true });
    expect(g.classList.contains('mm-node-out')).toBe(true);
    expect(g.classList.contains('mm-node-in')).toBe(false);
  });

  it('gets mm-node-editing while its inline editor is open', () => {
    expect(renderNode({ editing: true }).classList.contains('mm-node-editing')).toBe(true);
  });

  it('does not set a px transform-origin inline (would fight the CSS fill-box pivot)', () => {
    const g = renderNode({ animateIn: true });
    expect(g.style.transformOrigin).toBe('');
  });
});
