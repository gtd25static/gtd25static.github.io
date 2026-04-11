// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';
import { ToastContainer, toast } from '../../components/ui/Toast';

describe('ToastContainer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a toast message', () => {
    render(<ToastContainer />);
    act(() => { toast('Hello world'); });
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('auto-dismisses after 3 seconds (no undo)', () => {
    render(<ToastContainer />);
    act(() => { toast('Bye'); });
    expect(screen.getByText('Bye')).toBeInTheDocument();

    // After 3s, start exit animation
    act(() => { vi.advanceTimersByTime(3000); });
    // After 300ms exit animation, removed from DOM
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByText('Bye')).not.toBeInTheDocument();
  });

  it('auto-dismisses after 4 seconds when undo is provided', () => {
    render(<ToastContainer />);
    act(() => { toast('Deleted', 'info', () => {}); });
    expect(screen.getByText('Deleted')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(4000); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  });

  it('shows Undo button when onUndo is provided', () => {
    render(<ToastContainer />);
    act(() => { toast('Removed', 'info', () => {}); });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('does not show Undo when no onUndo', () => {
    render(<ToastContainer />);
    act(() => { toast('Info only'); });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('calls onUndo and dismisses when Undo is clicked', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const undoFn = vi.fn();
    render(<ToastContainer />);
    act(() => { toast('Deleted', 'info', undoFn); });
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undoFn).toHaveBeenCalledOnce();
  });

  it('can show multiple toasts', () => {
    render(<ToastContainer />);
    act(() => { toast('First'); });
    act(() => { toast('Second'); });
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });
});
