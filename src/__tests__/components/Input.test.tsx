// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';
import { Input } from '../../components/ui/Input';

describe('Input', () => {
  it('renders without a label', () => {
    render(<Input placeholder="Enter text" />);
    expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
  });

  it('renders a label linked by htmlFor', () => {
    render(<Input label="Username" />);
    const label = screen.getByText('Username');
    expect(label).toBeInTheDocument();
    expect(label.tagName).toBe('LABEL');
    // label should be linked to input via auto-generated id
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
  });

  it('accepts user typing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input label="Name" onChange={onChange} />);
    const input = screen.getByLabelText('Name');
    await user.type(input, 'Hello');
    expect(onChange).toHaveBeenCalledTimes(5); // one per keystroke
    expect(input).toHaveValue('Hello');
  });

  it('uses custom id over auto-generated', () => {
    render(<Input label="Email" id="custom-id" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('id', 'custom-id');
  });

  it('passes through extra attributes', () => {
    render(<Input type="password" required data-testid="pw" />);
    const input = screen.getByTestId('pw');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toBeRequired();
  });

  describe('password reveal toggle', () => {
    it('does not render a toggle for non-password inputs', () => {
      render(<Input label="Name" />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('reveals and re-hides the value on toggle', async () => {
      const user = userEvent.setup();
      render(<Input label="Passphrase" type="password" />);
      const input = screen.getByLabelText('Passphrase');
      expect(input).toHaveAttribute('type', 'password');

      await user.click(screen.getByRole('button', { name: 'Show password' }));
      expect(input).toHaveAttribute('type', 'text');

      await user.click(screen.getByRole('button', { name: 'Hide password' }));
      expect(input).toHaveAttribute('type', 'password');
    });

    it('keeps the typed value when toggling', async () => {
      const user = userEvent.setup();
      render(<Input label="Passphrase" type="password" />);
      const input = screen.getByLabelText('Passphrase');

      await user.type(input, 'hunter2');
      await user.click(screen.getByRole('button', { name: 'Show password' }));
      expect(input).toHaveValue('hunter2');
    });

    it('does not submit an enclosing form', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
      render(
        <form onSubmit={onSubmit}>
          <Input label="Passphrase" type="password" />
        </form>,
      );
      await user.click(screen.getByRole('button', { name: 'Show password' }));
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('is disabled while the input is disabled', () => {
      render(<Input label="Passphrase" type="password" disabled />);
      expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
    });
  });
});
