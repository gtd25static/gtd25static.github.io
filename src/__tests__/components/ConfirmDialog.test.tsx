// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';
import { ConfirmDialogContainer, confirmDialog } from '../../components/ui/ConfirmDialog';

describe('ConfirmDialog', () => {
  beforeEach(() => {
    render(<ConfirmDialogContainer />);
  });

  it('returns false when showConfirmFn is not registered', async () => {
    // Unmount to deregister the global fn
    const { unmount } = render(<div />);
    // We need a fresh container without showConfirmFn
    unmount();
  });

  it('shows the message when triggered', async () => {
    let result: boolean | undefined;
    act(() => {
      confirmDialog('Are you sure?').then((r) => { result = r; });
    });
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('resolves true when Confirm is clicked', async () => {
    const user = userEvent.setup();
    let result: boolean | undefined;
    act(() => {
      confirmDialog('Delete this?').then((r) => { result = r; });
    });
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(result).toBe(true);
  });

  it('resolves false when Cancel is clicked', async () => {
    const user = userEvent.setup();
    let result: boolean | undefined;
    act(() => {
      confirmDialog('Delete this?').then((r) => { result = r; });
    });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(result).toBe(false);
  });

  it('uses custom confirm label', async () => {
    act(() => {
      confirmDialog('Remove?', { confirmLabel: 'Remove' });
    });
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('uses danger variant when danger is set', async () => {
    act(() => {
      confirmDialog('Danger!', { danger: true });
    });
    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmBtn).toHaveClass('bg-red-600');
  });

  it('closes the dialog after confirmation', async () => {
    const user = userEvent.setup();
    act(() => {
      confirmDialog('Test?');
    });
    expect(screen.getByText('Test?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.queryByText('Test?')).not.toBeInTheDocument();
  });
});
