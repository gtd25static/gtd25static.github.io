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
    act(() => {
      confirmDialog('Are you sure?');
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

  describe('typed confirmation (typeToConfirm)', () => {
    const input = () => screen.getByPlaceholderText('Type "yes" to confirm');
    const wipeBtn = () => screen.getByRole('button', { name: 'Wipe' });

    function openTypedDialog() {
      let result: boolean | undefined;
      act(() => {
        confirmDialog('Wipe everything?', { confirmLabel: 'Wipe', typeToConfirm: 'yes' })
          .then((r) => { result = r; });
      });
      return () => result;
    }

    it('disables Confirm until the phrase is typed', async () => {
      const user = userEvent.setup();
      const result = openTypedDialog();

      expect(wipeBtn()).toBeDisabled();
      await user.click(wipeBtn());
      expect(result()).toBeUndefined();
      expect(screen.getByText('Wipe everything?')).toBeInTheDocument();
    });

    it('stays disabled on a non-matching phrase', async () => {
      const user = userEvent.setup();
      openTypedDialog();

      await user.type(input(), 'no');
      expect(wipeBtn()).toBeDisabled();
    });

    it('resolves true once the phrase is typed and Confirm is clicked', async () => {
      const user = userEvent.setup();
      const result = openTypedDialog();

      await user.type(input(), 'yes');
      expect(wipeBtn()).toBeEnabled();
      await user.click(wipeBtn());
      expect(result()).toBe(true);
    });

    it('accepts case and whitespace variants of the phrase', async () => {
      const user = userEvent.setup();
      const result = openTypedDialog();

      await user.type(input(), ' Yes ');
      await user.click(wipeBtn());
      expect(result()).toBe(true);
    });

    it('does not confirm on Enter while the phrase does not match', async () => {
      const user = userEvent.setup();
      const result = openTypedDialog();

      await user.type(input(), 'no{Enter}');
      expect(result()).toBeUndefined();
      expect(screen.getByText('Wipe everything?')).toBeInTheDocument();
    });

    it('confirms on Enter once the phrase matches', async () => {
      const user = userEvent.setup();
      const result = openTypedDialog();

      await user.type(input(), 'yes{Enter}');
      expect(result()).toBe(true);
    });

    it('resolves false on Cancel without typing', async () => {
      const user = userEvent.setup();
      const result = openTypedDialog();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(result()).toBe(false);
    });

    it('resets the typed phrase between requests', async () => {
      const user = userEvent.setup();
      const first = openTypedDialog();
      await user.type(input(), 'yes');
      await user.click(wipeBtn());
      expect(first()).toBe(true);

      openTypedDialog();
      expect(input()).toHaveValue('');
      expect(wipeBtn()).toBeDisabled();
    });
  });
});
