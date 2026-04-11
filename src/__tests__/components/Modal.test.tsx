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
});
