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

  describe('stays on screen inside scrolling containers', () => {
    // The sidebar's list rows sit in a scrolling <nav>: an absolutely-positioned
    // menu was clipped by it, and for the last lists Rename/Archive/Delete opened
    // below the viewport (GUI review).
    function placeTrigger(rect: Partial<DOMRect>) {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.dataset.dropdownTrigger !== undefined) {
          return { top: 0, left: 0, right: 0, bottom: 0, width: 32, height: 32, x: 0, y: 0, toJSON: () => ({}), ...rect } as DOMRect;
        }
        return { top: 0, left: 0, right: 160, bottom: 120, width: 160, height: 120, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });
    }
    afterEach(() => vi.restoreAllMocks());

    it('renders the menu outside any clipping ancestor', async () => {
      const user = userEvent.setup();
      render(<div style={{ overflow: 'hidden' }} data-testid="clip"><DropdownMenu trigger={<span>Menu</span>} items={items} /></div>);
      await user.click(screen.getByText('Menu'));
      expect(screen.getByTestId('clip').contains(screen.getByText('Edit'))).toBe(false);
      expect(document.querySelector<HTMLElement>('[data-dropdown-menu]')!).toHaveStyle({ position: 'fixed' });
    });

    it('opens upward when there is no room below the trigger', async () => {
      placeTrigger({ top: window.innerHeight - 40, bottom: window.innerHeight - 8, left: 100, right: 132 });
      const user = userEvent.setup();
      render(<DropdownMenu trigger={<span>Menu</span>} items={items} />);
      await user.click(screen.getByText('Menu'));
      const menu = document.querySelector<HTMLElement>('[data-dropdown-menu]')!;
      expect(parseFloat(menu.style.top)).toBeLessThan(window.innerHeight - 40);
    });

    it('opens downward when there is room', async () => {
      placeTrigger({ top: 40, bottom: 72, left: 100, right: 132 });
      const user = userEvent.setup();
      render(<DropdownMenu trigger={<span>Menu</span>} items={items} />);
      await user.click(screen.getByText('Menu'));
      expect(parseFloat(document.querySelector<HTMLElement>('[data-dropdown-menu]')!.style.top)).toBeGreaterThanOrEqual(72);
    });

    it('still closes on a click outside, and runs an item', async () => {
      const user = userEvent.setup();
      render(<><button>Elsewhere</button><DropdownMenu trigger={<span>Menu</span>} items={items} /></>);
      await user.click(screen.getByText('Menu'));
      await user.click(screen.getByText('Edit'));
      expect(items[0].onClick).toHaveBeenCalledOnce();
      await user.click(screen.getByText('Menu'));
      await user.click(screen.getByText('Elsewhere'));
      expect(document.querySelector('[data-dropdown-menu]')).not.toBeInTheDocument();
    });
  });
});
