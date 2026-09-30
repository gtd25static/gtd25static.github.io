// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';
import { DropdownMenu, placeMenu } from '../../components/ui/DropdownMenu';

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

  // The ⋮ triggers are icon-only: they had no accessible name at all.
  it('names its trigger, and says whether it is open', async () => {
    const user = userEvent.setup();
    render(<DropdownMenu trigger={<svg />} items={items} label="List options" />);
    const trigger = screen.getByRole('button', { name: 'List options' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('falls back to a generic name', () => {
    render(<DropdownMenu trigger={<svg />} items={items} />);
    expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
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

    // A long menu scrolls inside itself: that scroll must not count as the page moving.
    it('scrolling inside the menu keeps it open; scrolling the page closes it', async () => {
      const user = userEvent.setup();
      render(<DropdownMenu trigger={<span>Menu</span>} items={items} />);
      await user.click(screen.getByText('Menu'));
      fireEvent.scroll(document.querySelector('[data-dropdown-menu]')!);
      expect(document.querySelector('[data-dropdown-menu]')).toBeInTheDocument();
      fireEvent.scroll(document);
      expect(document.querySelector('[data-dropdown-menu]')).not.toBeInTheDocument();
    });

    it('caps its height to the room it opens into', async () => {
      placeTrigger({ top: 40, bottom: 72, left: 100, right: 132 });
      const user = userEvent.setup();
      render(<DropdownMenu trigger={<span>Menu</span>} items={items} />);
      await user.click(screen.getByText('Menu'));
      expect(document.querySelector<HTMLElement>('[data-dropdown-menu]')!.style.maxHeight).toBe(`${window.innerHeight - 8 - 76}px`);
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

  // The Inbox's Process menu lists every other list: with many lists it is taller
  // than the room below its button, and it was pushed up to cover the button.
  describe('placeMenu', () => {
    const trigger = (top: number) => ({ top, bottom: top + 32, left: 468, right: 500 }) as DOMRect;
    const roomBelow = (top: number) => window.innerHeight - 8 - (top + 32 + 4);

    it('fits below: right under the trigger, right edges aligned', () => {
      expect(placeMenu(trigger(100), { width: 200, height: 300 })).toEqual({ top: 136, left: 300, maxHeight: roomBelow(100) });
    });

    it('too tall for the room below: stays under the trigger and scrolls', () => {
      const place = placeMenu(trigger(300), { width: 200, height: 2000 });
      expect(place.top).toBe(336);
      expect(place.maxHeight).toBe(roomBelow(300));
    });

    it('opens above only when the room below is cramped and above is roomier', () => {
      const top = window.innerHeight - 100;
      const place = placeMenu(trigger(top), { width: 200, height: 300 });
      expect(place.top).toBe(top - 4 - 300); // its bottom edge just over the trigger
      expect(place.maxHeight).toBe(top - 4 - 8);
    });

    it('above, too tall even there: from the top of the screen, scrolling', () => {
      const top = window.innerHeight - 100;
      expect(placeMenu(trigger(top), { width: 200, height: 2000 })).toEqual({ top: 8, left: 300, maxHeight: top - 4 - 8 });
    });

    it('never leaves the viewport sideways', () => {
      expect(placeMenu({ ...trigger(100), right: 40 } as DOMRect, { width: 200, height: 100 }).left).toBe(8);
    });
  });
});
