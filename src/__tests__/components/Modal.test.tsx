// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';
import { Modal } from '../../components/ui/Modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(<Modal open={false} onClose={() => {}} title="Test">Content</Modal>);
    expect(screen.queryByText('Test')).not.toBeInTheDocument();
  });

  it('renders title and children when open', () => {
    render(<Modal open={true} onClose={() => {}} title="My Modal">Body text</Modal>);
    expect(screen.getByText('My Modal')).toBeInTheDocument();
    expect(screen.getByText('Body text')).toBeInTheDocument();
  });

  it('calls showModal on the dialog element when opening', () => {
    const { rerender } = render(<Modal open={false} onClose={() => {}} title="T">C</Modal>);
    rerender(<Modal open={true} onClose={() => {}} title="T">C</Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('open');
  });

  it('calls onClose when close button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal open={true} onClose={onClose} title="Test">Content</Modal>);
    await user.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders as a dialog element', () => {
    render(<Modal open={true} onClose={() => {}} title="T">C</Modal>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // Browsers run the "dialog focusing steps" inside showModal(): focus the first
  // [autofocus] descendant, else the first focusable one. React never writes the
  // autofocus attribute (autoFocus is a .focus() call at mount — a no-op while
  // the <dialog> is still closed/display:none), so focus used to land on the
  // Close button and typing into "New map" went nowhere. jsdom's stand-in only
  // sets `open`, so emulate the focusing steps here.
  describe('initial focus', () => {
    let original: typeof HTMLDialogElement.prototype.showModal;
    beforeEach(() => {
      original = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
        const target = this.querySelector<HTMLElement>('[autofocus]')
          ?? this.querySelector<HTMLElement>('button, input, textarea, select, a[href], [tabindex]');
        target?.focus();
      };
    });
    afterEach(() => {
      HTMLDialogElement.prototype.showModal = original;
    });

    it('focuses the autoFocus field, not the Close button', () => {
      render(<Modal open onClose={() => {}} title="New map"><input placeholder="Name" autoFocus /></Modal>);
      expect(screen.getByPlaceholderText('Name')).toHaveFocus();
    });

    it('does so again every time it reopens', () => {
      const body = <input placeholder="Name" autoFocus />;
      const { rerender } = render(<Modal open={false} onClose={() => {}} title="T">{body}</Modal>);
      rerender(<Modal open onClose={() => {}} title="T">{body}</Modal>);
      expect(screen.getByPlaceholderText('Name')).toHaveFocus();
      rerender(<Modal open={false} onClose={() => {}} title="T">{body}</Modal>);
      rerender(<Modal open onClose={() => {}} title="T">{body}</Modal>);
      expect(screen.getByPlaceholderText('Name')).toHaveFocus();
    });

    it('without an autoFocus field, keeps the browser default (the Close button)', () => {
      render(<Modal open onClose={() => {}} title="Help"><input placeholder="Search" /></Modal>);
      expect(screen.getByLabelText('Close')).toHaveFocus();
    });
  });
});
