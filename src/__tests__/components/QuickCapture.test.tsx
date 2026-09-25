// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { resetAppState } from '../helpers/component-helpers';
import { useAppState } from '../../stores/app-state';
import { QuickCapture } from '../../components/tasks/QuickCapture';
import { ToastContainer } from '../../components/ui/Toast';

const mockCreateTask = vi.fn().mockResolvedValue({ id: 'new-1' });
const mockGetOrCreateInbox = vi.fn().mockResolvedValue('inbox-1');

vi.mock('../../hooks/use-tasks', () => ({
  createTask: (...args: unknown[]) => mockCreateTask(...args),
}));

vi.mock('../../hooks/use-task-lists', () => ({
  getOrCreateInbox: () => mockGetOrCreateInbox(),
}));

describe('QuickCapture', () => {
  beforeEach(() => {
    resetAppState();
    vi.clearAllMocks();
  });

  it('renders nothing when closed', () => {
    render(<QuickCapture />);
    expect(screen.queryByPlaceholderText('Quick capture to Inbox...')).not.toBeInTheDocument();
  });

  it('renders input when open', () => {
    useAppState.setState({ quickCaptureOpen: true });
    render(<QuickCapture />);
    expect(screen.getByPlaceholderText('Quick capture to Inbox...')).toBeInTheDocument();
  });

  it('shows Capture button disabled when empty', () => {
    useAppState.setState({ quickCaptureOpen: true });
    render(<QuickCapture />);
    expect(screen.getByRole('button', { name: 'Capture' })).toBeDisabled();
  });

  it('creates a task on submit', async () => {
    useAppState.setState({ quickCaptureOpen: true });
    const user = userEvent.setup();
    render(
      <>
        <ToastContainer />
        <QuickCapture />
      </>,
    );
    await user.type(screen.getByPlaceholderText('Quick capture to Inbox...'), 'New idea');
    await user.click(screen.getByRole('button', { name: 'Capture' }));
    expect(mockGetOrCreateInbox).toHaveBeenCalled();
    expect(mockCreateTask).toHaveBeenCalledWith('inbox-1', expect.objectContaining({ title: 'New idea' }));
  });

  it('clears input after submission but stays open', async () => {
    useAppState.setState({ quickCaptureOpen: true });
    const user = userEvent.setup();
    render(
      <>
        <ToastContainer />
        <QuickCapture />
      </>,
    );
    const input = screen.getByPlaceholderText('Quick capture to Inbox...');
    await user.type(input, 'Quick item');
    await user.click(screen.getByRole('button', { name: 'Capture' }));
    expect(input).toHaveValue('');
    // Should still be open
    expect(screen.getByPlaceholderText('Quick capture to Inbox...')).toBeInTheDocument();
  });

  it('closes on Escape key', async () => {
    useAppState.setState({ quickCaptureOpen: true });
    const user = userEvent.setup();
    render(<QuickCapture />);
    await user.click(screen.getByPlaceholderText('Quick capture to Inbox...'));
    await user.keyboard('{Escape}');
    expect(useAppState.getState().quickCaptureOpen).toBe(false);
  });

  it('closes when backdrop is clicked', async () => {
    useAppState.setState({ quickCaptureOpen: true });
    const user = userEvent.setup();
    const { container } = render(<QuickCapture />);
    // Backdrop is the first fixed div
    const backdrop = container.querySelector('.fixed.inset-0');
    expect(backdrop).toBeTruthy();
    await user.click(backdrop!);
    expect(useAppState.getState().quickCaptureOpen).toBe(false);
  });

  it('does not submit empty input', async () => {
    useAppState.setState({ quickCaptureOpen: true });
    const user = userEvent.setup();
    render(<QuickCapture />);
    await user.type(screen.getByPlaceholderText('Quick capture to Inbox...'), '{Enter}');
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  // The field used to be cleared only after awaiting getOrCreateInbox() and
  // createTask(): keystrokes typed during that await landed in the old title and
  // were then wiped or merged into it (lost first chars, "alpha onebravo two").
  describe('typing the next item while the previous one saves', { timeout: 15_000 }, () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    }

    function renderOpen() {
      useAppState.setState({ quickCaptureOpen: true });
      const user = userEvent.setup();
      render(<><ToastContainer /><QuickCapture /></>);
      return { user, input: screen.getByPlaceholderText('Quick capture to Inbox...') };
    }

    it('clears the field on Enter, before the save finishes, and keeps what is typed next', async () => {
      const inbox = deferred<string>();
      mockGetOrCreateInbox.mockReturnValueOnce(inbox.promise);
      const { user, input } = renderOpen();

      await user.type(input, 'alpha one{Enter}');
      expect(input).toHaveValue('');
      await user.type(input, 'bravo');
      expect(input).toHaveValue('bravo');

      await act(async () => { inbox.resolve('inbox-1'); });
      await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(1));
      expect(input).toHaveValue('bravo');
      expect(mockCreateTask).toHaveBeenCalledWith('inbox-1', expect.objectContaining({ title: 'alpha one' }));

      await user.type(input, ' two{Enter}');
      await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(2));
      expect(mockCreateTask).toHaveBeenLastCalledWith('inbox-1', expect.objectContaining({ title: 'bravo two' }));
    });

    it('a second Enter on the same item does not capture it twice', async () => {
      const inbox = deferred<string>();
      mockGetOrCreateInbox.mockReturnValueOnce(inbox.promise);
      const { user, input } = renderOpen();

      await user.type(input, 'once{Enter}{Enter}');
      await act(async () => { inbox.resolve('inbox-1'); });
      await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(mockCreateTask).toHaveBeenCalledTimes(1);
    });

    it('saves items one after another, in the order typed', async () => {
      const inbox = deferred<string>();
      mockGetOrCreateInbox.mockReturnValueOnce(inbox.promise);
      const { user, input } = renderOpen();

      await user.type(input, 'first{Enter}second{Enter}');
      // The second save waits for the first (so a first-ever capture can't
      // create two Inboxes).
      expect(mockGetOrCreateInbox).toHaveBeenCalledTimes(1);

      await act(async () => { inbox.resolve('inbox-1'); });
      await waitFor(() => expect(mockCreateTask).toHaveBeenCalledTimes(2));
      expect(mockCreateTask.mock.calls.map((c) => c[1].title)).toEqual(['first', 'second']);
    });
  });

  it('extracts URL from input and sets as link', async () => {
    useAppState.setState({ quickCaptureOpen: true });
    const user = userEvent.setup();
    render(
      <>
        <ToastContainer />
        <QuickCapture />
      </>,
    );
    await user.type(screen.getByPlaceholderText('Quick capture to Inbox...'), 'Check https://example.com out');
    await user.click(screen.getByRole('button', { name: 'Capture' }));
    expect(mockCreateTask).toHaveBeenCalledWith('inbox-1', expect.objectContaining({
      link: 'https://example.com',
    }));
  });
});
