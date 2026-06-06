// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import '../setup-component';
import { ExpandableText } from '../../components/shared/ExpandableText';

// jsdom has no layout, so drive overflow detection by stubbing the size getters.
let scrollH = 0;
let clientH = 0;
function setOverflow(overflowing: boolean) {
  clientH = 50;
  scrollH = overflowing ? 200 : 50;
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollH });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => clientH });
});

describe('ExpandableText', () => {
  it('renders the text', () => {
    setOverflow(false);
    render(<ExpandableText text="hello world" />);
    expect(screen.getByText('hello world')).toBeInTheDocument();
  });

  it('is inert (no expand affordance) when it does not overflow', () => {
    setOverflow(false);
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <ExpandableText text="short" title="Double-click to edit" />
      </div>,
    );
    const el = screen.getByText('short');
    expect(el.className).not.toContain('cursor-pointer');
    expect(el).toHaveAttribute('title', 'Double-click to edit');

    fireEvent.click(el);
    // Nothing to expand -> click reaches the card.
    expect(parentClick).toHaveBeenCalledTimes(1);
  });

  it('expands and collapses on click when it overflows, and stops propagation', () => {
    setOverflow(true);
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <ExpandableText text="a very long piece of text" />
      </div>,
    );
    const el = screen.getByText('a very long piece of text');
    expect(el.className).toContain('cursor-pointer');
    expect(el).toHaveAttribute('title', 'Click to expand');

    fireEvent.click(el);
    expect(el).toHaveAttribute('title', 'Click to collapse'); // expanded
    expect(parentClick).not.toHaveBeenCalled(); // propagation stopped

    fireEvent.click(el);
    expect(el).toHaveAttribute('title', 'Click to expand'); // collapsed again
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('forwards onDoubleClick (e.g. inline edit)', () => {
    setOverflow(false);
    const onDoubleClick = vi.fn();
    render(<ExpandableText text="editable" onDoubleClick={onDoubleClick} />);
    fireEvent.doubleClick(screen.getByText('editable'));
    expect(onDoubleClick).toHaveBeenCalled();
  });

  it('clamps with the requested line count while collapsed', () => {
    setOverflow(true);
    render(<ExpandableText text="clamp me" clamp={1} />);
    const el = screen.getByText('clamp me');
    expect(el.style.webkitLineClamp).toBe('1');
  });
});
