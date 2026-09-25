// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import '../setup-component';
import { resetAppState } from '../helpers/component-helpers';
import { DndProvider } from '../../components/layout/DndProvider';
import { useAppState } from '../../stores/app-state';

// Phones: dragging a task auto-opens the sidebar drawer. dnd-kit measures the
// droppables when the drag starts, i.e. while the drawer is still off-screen
// (-translate-x-full), and never re-measured, so the lists could not be hit.

let drawerLeft = -300;

function Task() {
  const { setNodeRef, attributes, listeners } = useDraggable({ id: 't1', data: { type: 'task', listId: 'src', title: 'Carry me' } });
  return <div ref={setNodeRef} {...attributes} {...listeners}>Carry me</div>;
}

function SidebarRow() {
  const { setNodeRef } = useDroppable({ id: 'list-drop-dest', data: { type: 'sidebarList', listId: 'dest', listType: 'tasks' } });
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        if (el) {
          el.getBoundingClientRect = () => ({
            left: drawerLeft, right: drawerLeft + 240, top: 100, bottom: 132, width: 240, height: 32, x: drawerLeft, y: 100,
            toJSON: () => ({}),
          });
        }
      }}
    >
      Dest
    </div>
  );
}

let measuredLeft: number | undefined;
const recordLeft = (left: number | undefined) => { measuredLeft = left; };
function RectProbe() {
  const { droppableRects } = useDndContext();
  const left = droppableRects.get('list-drop-dest')?.left;
  useEffect(() => recordLeft(left), [left]);
  return null;
}

describe('DndProvider', { timeout: 15_000 }, () => {
  const originalWidth = window.innerWidth;

  beforeEach(() => {
    resetAppState();
    drawerLeft = -300;
    measuredLeft = undefined;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    useAppState.getState().setSidebarOpen(false);
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  });

  it('re-measures the sidebar lists once the auto-opened drawer has slid in', async () => {
    render(<DndProvider><Task /><SidebarRow /><RectProbe /></DndProvider>);
    const task = screen.getByText('Carry me');
    task.focus();
    await act(async () => { fireEvent.keyDown(task, { key: ' ', code: 'Space' }); });

    expect(useAppState.getState().sidebarOpen).toBe(true);
    await waitFor(() => expect(measuredLeft).toBe(-300)); // measured at drag start, off-screen

    drawerLeft = 0; // the drawer finished sliding in
    await waitFor(() => expect(measuredLeft).toBe(0));

    await act(async () => { fireEvent.keyDown(document.activeElement ?? task, { key: 'Escape', code: 'Escape' }); });
  });
});
