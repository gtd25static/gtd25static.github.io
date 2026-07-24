// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import '../setup-component';
import type { MindmapLayout } from '../../lib/mindmap-layout';
import { EXIT_MS, LAYOUT_MS } from '../../lib/mindmap-motion';
import { useAnimatedLayout } from '../../hooks/use-animated-layout';

function layout(boxes: Record<string, [number, number]>): MindmapLayout {
  return {
    rects: new Map(Object.entries(boxes).map(([id, [x, y]]) => [id, { x, y, w: 100, h: 30 }])),
    edges: [],
    bounds: { minX: 0, minY: 0, maxX: 400, maxY: 400 },
  };
}

let frames: FrameRequestCallback[] = [];
let clock = 0;

/** Run every frame the hook has queued, as if `at` ms had elapsed. */
function runFrames(at: number) {
  clock = at;
  const pending = frames.splice(0, frames.length);
  act(() => { for (const cb of pending) cb(at); });
}

beforeEach(() => {
  frames = [];
  clock = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const A = layout({ root: [0, 0], a: [200, 0], b: [200, 60] });
const B = layout({ root: [0, 0], a: [200, 30], b: [200, 90] });

describe('useAnimatedLayout', () => {
  it('is a pass-through when disabled — same object, no frames scheduled', () => {
    const { result, rerender } = renderHook(
      ({ l }: { l: MindmapLayout }) => useAnimatedLayout(l, false),
      { initialProps: { l: A } },
    );
    expect(result.current.layout).toBe(A);
    rerender({ l: B });
    expect(result.current.layout).toBe(B);
    expect(result.current.exiting.size).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it('glides to the new target and lands exactly on it', () => {
    const { result, rerender } = renderHook(
      ({ l }: { l: MindmapLayout }) => useAnimatedLayout(l, true),
      { initialProps: { l: A } },
    );
    runFrames(0);

    clock = 1000;
    rerender({ l: B });
    expect(result.current.layout.rects.get('a')!.y).toBe(0); // still where it was

    // A quarter of the way in: moved off the start but not yet at (or past, via
    // the ease's overshoot) the target of 30.
    runFrames(1000 + LAYOUT_MS / 4);
    const midY = result.current.layout.rects.get('a')!.y;
    expect(midY).toBeGreaterThan(0);
    expect(midY).toBeLessThan(30);

    runFrames(1000 + LAYOUT_MS);
    expect(result.current.layout).toBe(B);
    expect(frames).toHaveLength(0); // and it stops asking for frames
  });

  it('picks a new target up from where the boxes are, not from a stale start', () => {
    const { result, rerender } = renderHook(
      ({ l }: { l: MindmapLayout }) => useAnimatedLayout(l, true),
      { initialProps: { l: A } },
    );
    runFrames(0);
    clock = 500;
    rerender({ l: B });
    runFrames(500 + LAYOUT_MS / 2);
    const interrupted = result.current.layout.rects.get('a')!.y;

    clock = 600;
    rerender({ l: A }); // reverse mid-flight
    runFrames(600);
    // The first frame of the new run starts from where it visibly was
    expect(result.current.layout.rects.get('a')!.y).toBeCloseTo(interrupted, 5);
  });

  it('runs big reveals at a scaled-down duration, small re-layouts at full', () => {
    const many = (yOff: number) => {
      const boxes: Record<string, [number, number]> = { root: [0, yOff] };
      for (let i = 0; i < 9; i++) boxes[`n${i}`] = [200, i * 40 + yOff];
      return layout(boxes);
    };
    const { result, rerender } = renderHook(
      ({ l }: { l: MindmapLayout }) => useAnimatedLayout(l, true),
      { initialProps: { l: layout({ root: [0, 0] }) } },
    );
    runFrames(0);
    expect(result.current.durationScale).toBe(1);

    // Expand-all: 9 of 10 nodes enter at once → duration scales down…
    const unfolded = many(0);
    clock = 1000;
    rerender({ l: unfolded });
    expect(result.current.durationScale).toBeCloseTo(1 - 0.6 * (9 / 10), 5);
    // …so at half of LAYOUT_MS the glide has already landed.
    runFrames(1000 + LAYOUT_MS / 2);
    expect(result.current.layout).toBe(unfolded);

    // A pure re-layout of the same nodes runs at full duration again.
    const moved = many(10);
    clock = 2000;
    rerender({ l: moved });
    expect(result.current.durationScale).toBe(1);
    runFrames(2000 + LAYOUT_MS / 2);
    expect(result.current.layout).not.toBe(moved); // still mid-flight
    runFrames(2000 + LAYOUT_MS);
    expect(result.current.layout).toBe(moved);
  });

  it('holds nodes that left at their last box, then drops them', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { result, rerender } = renderHook(
        ({ l }: { l: MindmapLayout }) => useAnimatedLayout(l, true),
        { initialProps: { l: A } },
      );
      runFrames(0);

      clock = 1000;
      rerender({ l: layout({ root: [0, 0], a: [200, 0] }) }); // b collapsed away
      expect(result.current.exiting.get('b')).toEqual({ x: 200, y: 60, w: 100, h: 30 });

      act(() => { vi.advanceTimersByTime(EXIT_MS + 1); });
      expect(result.current.exiting.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops holding a node that comes straight back', () => {
    const { result, rerender } = renderHook(
      ({ l }: { l: MindmapLayout }) => useAnimatedLayout(l, true),
      { initialProps: { l: A } },
    );
    runFrames(0);
    clock = 1000;
    rerender({ l: layout({ root: [0, 0], a: [200, 0] }) });
    expect(result.current.exiting.has('b')).toBe(true);

    clock = 1010;
    rerender({ l: A });
    expect(result.current.exiting.has('b')).toBe(false);
  });
});
