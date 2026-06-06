// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import '../setup-component';
import { CheckForUpdatesButton } from '../../components/layout/CheckForUpdatesButton';

// Mutable holder so each test can choose what the SW reports.
const h = vi.hoisted(() => ({ needRefresh: false, forceCheck: vi.fn() }));
const toastMock = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/use-service-worker', () => ({
  useServiceWorker: () => ({
    needRefresh: h.needRefresh,
    forceCheck: h.forceCheck,
    applyUpdate: vi.fn(),
    checkForUpdate: vi.fn(),
  }),
}));
vi.mock('../../components/ui/Toast', () => ({ toast: toastMock }));

describe('CheckForUpdatesButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.needRefresh = false;
    h.forceCheck = vi.fn();
    toastMock.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('renders the idle label', () => {
    render(<CheckForUpdatesButton />);
    expect(screen.getByText('Check for app updates')).toBeInTheDocument();
  });

  it('triggers a check, calls onActivate, and shows a checking state', () => {
    const onActivate = vi.fn();
    render(<CheckForUpdatesButton onActivate={onActivate} />);

    fireEvent.click(screen.getByRole('button'));

    expect(h.forceCheck).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('reassures the user when no update is found after the detect window', () => {
    render(<CheckForUpdatesButton />);
    fireEvent.click(screen.getByRole('button'));

    act(() => { vi.advanceTimersByTime(4000); });

    expect(toastMock).toHaveBeenCalledWith('You’re on the latest version', 'success');
    // Returns to the idle, enabled state.
    expect(screen.getByText('Check for app updates')).toBeInTheDocument();
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('stays silent when an update was found (needRefresh)', () => {
    h.needRefresh = true; // a waiting build turned up; AppUpdatePrompt handles the dialog
    render(<CheckForUpdatesButton />);
    fireEvent.click(screen.getByRole('button'));

    act(() => { vi.advanceTimersByTime(4000); });

    expect(toastMock).not.toHaveBeenCalled();
  });

  it('does not fire a second check while one is in flight', () => {
    render(<CheckForUpdatesButton />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    fireEvent.click(btn); // disabled now — ignored

    expect(h.forceCheck).toHaveBeenCalledTimes(1);
  });
});
