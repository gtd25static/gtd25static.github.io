// @vitest-environment jsdom
import { render, screen, act, fireEvent } from '@testing-library/react';
import '../setup-component';

const touch = vi.hoisted(() => vi.fn());
vi.mock('../../db/vault', () => ({ touchVaultActivity: touch }));

import { RotationProgressDialog } from '../../components/settings/RotationProgressDialog';

// Changing the sync password rewrites the whole repository; interrupting it
// half-way is recoverable but alarming. It used to show one small status line
// under the Save button. It now takes over the screen until it finishes.

afterEach(() => vi.useRealTimers());

describe('RotationProgressDialog', () => {
  it('renders nothing when no rotation is running', () => {
    render(<RotationProgressDialog progress={null} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('covers the screen with every step, the finished ones ticked and the current one live', () => {
    render(<RotationProgressDialog progress={{ phase: 'files', done: 2, total: 5 }} />);
    const dialog = screen.getByRole('dialog', { name: 'Changing the sync password' });
    expect(dialog).toHaveAttribute('open');
    expect(dialog.textContent).toMatch(/Keep this window open/);
    expect(screen.getByText('Syncing the latest changes').closest('li')).toHaveAttribute('data-state', 'done');
    expect(screen.getByText(/Re-encrypting shared files/).closest('li')).toHaveAttribute('data-state', 'current');
    expect(screen.getByText(/3\/5/)).toBeInTheDocument();
    expect(screen.getByText('Rewriting your data under the new password').closest('li')).toHaveAttribute('data-state', 'pending');
  });

  it('cannot be dismissed with Escape', () => {
    render(<RotationProgressDialog progress={{ phase: 'snapshot' }} />);
    const dialog = screen.getByRole('dialog');
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog).toHaveAttribute('open');
  });

  it('asks the browser to confirm before the page is closed or reloaded, only while it runs', () => {
    const { rerender } = render(<RotationProgressDialog progress={{ phase: 'backups' }} />);
    const during = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);

    rerender(<RotationProgressDialog progress={null} />);
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('keeps the vault\'s idle lock from firing mid-rotation', () => {
    vi.useFakeTimers();
    const { rerender } = render(<RotationProgressDialog progress={{ phase: 'history' }} />);
    touch.mockClear();
    act(() => { vi.advanceTimersByTime(45_000); });
    expect(touch.mock.calls.length).toBeGreaterThanOrEqual(3);

    rerender(<RotationProgressDialog progress={null} />);
    touch.mockClear();
    act(() => { vi.advanceTimersByTime(45_000); });
    expect(touch).not.toHaveBeenCalled();
  });

  it('the step list follows the progress', () => {
    const { rerender } = render(<RotationProgressDialog progress={{ phase: 'syncing' }} />);
    expect(screen.getByText('Syncing the latest changes').closest('li')).toHaveAttribute('data-state', 'current');
    rerender(<RotationProgressDialog progress={{ phase: 'registry' }} />);
    expect(screen.getByText('Rewriting the backups').closest('li')).toHaveAttribute('data-state', 'done');
    expect(screen.getByText('Updating the device registry').closest('li')).toHaveAttribute('data-state', 'current');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toHaveAttribute('open');
  });
});
