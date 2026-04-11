// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
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
