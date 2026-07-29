// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import '../setup-component';
import { useSidebarSwipe } from '../../hooks/use-sidebar-swipe';
import { useAppState } from '../../stores/app-state';

function Harness() {
  useSidebarSwipe();
  return (
    <div>
      <div data-testid="page" style={{ width: 400, height: 400 }} />
      <div data-no-sidebar-swipe data-testid="canvas">
        <span data-testid="canvas-child" />
      </div>
    </div>
  );
}

/** jsdom has no TouchEvent constructor with touch lists — build the shape the hook reads. */
function touch(type: 'touchstart' | 'touchend', target: Element, x: number, y: number) {
  const event = new Event(type, { bubbles: true }) as TouchEvent & { touches: unknown; changedTouches: unknown };
  const list = [{ clientX: x, clientY: y }];
  Object.defineProperty(event, 'touches', { value: list });
  Object.defineProperty(event, 'changedTouches', { value: list });
  act(() => { target.dispatchEvent(event); });
}

function swipe(target: Element, from: number, to: number, y = 100) {
  touch('touchstart', target, from, y);
  touch('touchend', target, to, y);
}

beforeEach(() => {
  useAppState.setState({ sidebarOpen: false });
});

describe('useSidebarSwipe', () => {
  it('opens the sidebar on a right swipe over ordinary page content', () => {
    const { getByTestId } = render(<Harness />);
    swipe(getByTestId('page'), 20, 120);
    expect(useAppState.getState().sidebarOpen).toBe(true);
  });

  it('closes the sidebar on a left swipe when it is open', () => {
    useAppState.setState({ sidebarOpen: true });
    const { getByTestId } = render(<Harness />);
    swipe(getByTestId('page'), 200, 80);
    expect(useAppState.getState().sidebarOpen).toBe(false);
  });

  it('ignores a swipe that starts inside a data-no-sidebar-swipe surface', () => {
    const { getByTestId } = render(<Harness />);
    swipe(getByTestId('canvas'), 20, 200);
    expect(useAppState.getState().sidebarOpen).toBe(false);
  });

  it('ignores a swipe starting on a descendant of that surface (the map itself)', () => {
    const { getByTestId } = render(<Harness />);
    swipe(getByTestId('canvas-child'), 20, 200);
    expect(useAppState.getState().sidebarOpen).toBe(false);
  });

  it('still ignores mostly-vertical drags elsewhere (scrolling)', () => {
    const { getByTestId } = render(<Harness />);
    touch('touchstart', getByTestId('page'), 20, 20);
    touch('touchend', getByTestId('page'), 100, 300);
    expect(useAppState.getState().sidebarOpen).toBe(false);
  });
});
