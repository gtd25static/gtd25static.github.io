// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';
import { DropdownMenu } from '../../components/ui/DropdownMenu';

const items = [
  { label: 'Edit', onClick: vi.fn() },
  { label: 'Delete', onClick: vi.fn(), danger: true },
];

describe('DropdownMenu', () => {
  beforeEach(() => {
    items.forEach((i) => i.onClick.mockClear());
  });

  it('renders the trigger', () => {
    render(<DropdownMenu trigger={<span>Menu</span>} items={items} />);
    expect(screen.getByText('Menu')).toBeInTheDocument();
  });

  it('does not show items initially', () => {
    render(<DropdownMenu trigger={<span>Menu</span>} items={items} />);
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('shows items when trigger is clicked', async () => {
    const user = userEvent.setup();
    render(<DropdownMenu trigger={<span>Menu</span>} items={items} />);
    await user.click(screen.getByText('Menu'));
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('calls item onClick and closes when item is clicked', async () => {
    const user = userEvent.setup();
    render(<DropdownMenu trigger={<span>Menu</span>} items={items} />);
    await user.click(screen.getByText('Menu'));
    await user.click(screen.getByText('Edit'));
    expect(items[0].onClick).toHaveBeenCalledOnce();
    // Menu should close after item click
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('closes when clicking outside', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <DropdownMenu trigger={<span>Menu</span>} items={items} />
        <button>Outside</button>
      </div>
    );
    await user.click(screen.getByText('Menu'));
    expect(screen.getByText('Edit')).toBeInTheDocument();
    await user.click(screen.getByText('Outside'));
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('toggles on repeated trigger clicks', async () => {
    const user = userEvent.setup();
    render(<DropdownMenu trigger={<span>Menu</span>} items={items} />);
    await user.click(screen.getByText('Menu'));
    expect(screen.getByText('Edit')).toBeInTheDocument();
    await user.click(screen.getByText('Menu'));
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });
});
