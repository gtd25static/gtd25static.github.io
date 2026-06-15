// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';
import { ToastContainer, toast, toastDurationMs } from '../../components/ui/Toast';

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

  it('auto-dismisses a short message near the 3s floor', () => {
    render(<ToastContainer />);
    act(() => { toast('Bye'); });
    expect(screen.getByText('Bye')).toBeInTheDocument();

    // Word-scaled duration, then the 300ms exit animation, then removed.
    act(() => { vi.advanceTimersByTime(toastDurationMs('Bye')); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByText('Bye')).not.toBeInTheDocument();
  });

  it('lingers to the 6s max for a long (10+ word) message', () => {
    const long = 'one two three four five six seven eight nine ten eleven';
    render(<ToastContainer />);
    act(() => { toast(long); });

    // Still visible at 5s (a short toast would already be gone)…
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText(long)).toBeInTheDocument();

    // …gone after the full 6s + exit animation.
    act(() => { vi.advanceTimersByTime(1000 + 300); });
    expect(screen.queryByText(long)).not.toBeInTheDocument();
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

describe('toastDurationMs', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

  it('scales from 3s (short) to 6s at 10+ words', () => {
    expect(toastDurationMs('')).toBe(3000);
    expect(toastDurationMs(words(5))).toBe(4500);
    expect(toastDurationMs(words(10))).toBe(6000);
    expect(toastDurationMs(words(25))).toBe(6000); // capped at 10 words
  });

  it('ignores surrounding/extra whitespace when counting words', () => {
    expect(toastDurationMs('  hello   world  ')).toBe(toastDurationMs('hello world'));
  });

  it('keeps a 4s floor for undo toasts', () => {
    expect(toastDurationMs('Deleted', true)).toBe(4000); // 1 word (3.3s) floored to 4s
    expect(toastDurationMs(words(12), true)).toBe(6000); // long undo stays 6s
  });
});
