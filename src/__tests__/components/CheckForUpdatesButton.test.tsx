// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { CheckForUpdatesButton } from '../../components/layout/CheckForUpdatesButton';
import type { UpdateCheckResult } from '../../hooks/use-service-worker';

// The button reports what the check actually found. It used to wait out a fixed
// four seconds over a fire-and-forget call and then claim the device was on the
// latest version — the same answer whether nothing was new, nothing was
// registered to install updates, or the request was never answered.

const h = vi.hoisted(() => ({ forceCheck: vi.fn() }));
const toastMock = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/use-service-worker', () => ({
  useServiceWorker: () => ({
    needRefresh: false,
    forceCheck: h.forceCheck,
    applyUpdate: vi.fn(),
    checkForUpdate: vi.fn(),
  }),
}));
vi.mock('../../components/ui/Toast', () => ({ toast: toastMock }));

function clickCheck() {
  return userEvent.setup().click(screen.getByRole('button'));
}

beforeEach(() => {
  h.forceCheck = vi.fn().mockResolvedValue('up-to-date' satisfies UpdateCheckResult);
  toastMock.mockClear();
});

describe('CheckForUpdatesButton', () => {
  it('renders the idle label', () => {
    render(<CheckForUpdatesButton />);
    expect(screen.getByText('Check for app updates')).toBeInTheDocument();
  });

  it('triggers a check and calls onActivate', async () => {
    const onActivate = vi.fn();
    render(<CheckForUpdatesButton onActivate={onActivate} />);

    await clickCheck();

    expect(h.forceCheck).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('reassures the user only when the check really found nothing new', async () => {
    render(<CheckForUpdatesButton />);
    await clickCheck();

    expect(toastMock).toHaveBeenCalledWith('You’re on the latest version', 'success');
    expect(screen.getByText('Check for app updates')).toBeInTheDocument();
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('stays silent when a build was found, because the update prompt takes over', async () => {
    h.forceCheck.mockResolvedValue('update-found' satisfies UpdateCheckResult);
    render(<CheckForUpdatesButton />);

    await clickCheck();

    expect(toastMock).not.toHaveBeenCalled();
  });

  it('says a newer build is deployed when this device did not pick it up', async () => {
    h.forceCheck.mockResolvedValue('stale-worker' satisfies UpdateCheckResult);
    render(<CheckForUpdatesButton />);

    await clickCheck();

    const [message, kind] = toastMock.mock.calls[0] as [string, string];
    expect(message).toMatch(/newer version is deployed/);
    expect(message).toMatch(/Force update & reload/);
    expect(kind).toBe('error');
  });

  it('says so when nothing is registered to install updates', async () => {
    h.forceCheck.mockResolvedValue('no-worker' satisfies UpdateCheckResult);
    render(<CheckForUpdatesButton />);

    await clickCheck();

    const [message, kind] = toastMock.mock.calls[0] as [string, string];
    expect(message).toMatch(/can’t check for updates/);
    expect(message).toMatch(/Force update & reload/);
    expect(kind).toBe('error');
  });

  it('says the check could not complete, instead of calling it up to date', async () => {
    h.forceCheck.mockResolvedValue('failed' satisfies UpdateCheckResult);
    render(<CheckForUpdatesButton />);

    await clickCheck();

    const [message, kind] = toastMock.mock.calls[0] as [string, string];
    expect(message).toMatch(/Could not check for updates/);
    expect(kind).toBe('error');
  });

  it('shows a checking state for as long as the check runs, and ignores a second click', async () => {
    let release!: (result: UpdateCheckResult) => void;
    h.forceCheck.mockReturnValue(new Promise<UpdateCheckResult>((resolve) => { release = resolve; }));
    render(<CheckForUpdatesButton />);

    await clickCheck();
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();

    await clickCheck(); // disabled — ignored
    expect(h.forceCheck).toHaveBeenCalledTimes(1);
    expect(toastMock).not.toHaveBeenCalled();

    await act(async () => { release('up-to-date'); });
    await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled());
    expect(toastMock).toHaveBeenCalledWith('You’re on the latest version', 'success');
  });
});
