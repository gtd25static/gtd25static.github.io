// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { makeTask } from '../helpers/component-helpers';
import { DiscussedPopover } from '../../components/follow-ups/DiscussedPopover';

const mockUpdateTask = vi.fn();
vi.mock('../../hooks/use-tasks', () => ({
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
}));

const DAY = 24 * 60 * 60 * 1000;

describe('DiscussedPopover', () => {
  beforeEach(() => vi.clearAllMocks());

  function renderPopover(overrides = {}) {
    const task = makeTask('fu-1', overrides);
    const user = userEvent.setup();
    const result = render(<DiscussedPopover task={task} align="right" onDone={() => {}} />);
    return { task, user, ...result };
  }

  it('opens downward by default when there is room below', () => {
    const { container } = renderPopover();
    const panel = container.firstChild as HTMLElement;
    expect(panel.className).toContain('top-full');
    expect(panel.className).not.toContain('bottom-full');
  });

  it('flips upward when the panel would overflow the bottom of the viewport', () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ bottom: window.innerHeight + 100 } as DOMRect);
    try {
      const { container } = renderPopover();
      const panel = container.firstChild as HTMLElement;
      expect(panel.className).toContain('bottom-full');
      expect(panel.className).not.toContain('top-full');
    } finally {
      spy.mockRestore();
    }
  });

  // Phones: the chip sits at the left of the card but the 256px panel is
  // right-aligned to it, so it opened ~128px off the left edge and Snooze and
  // the presets could not be tapped.
  describe('horizontal clamping', () => {
    function mockPanelRect(left: number, width = 256) {
      return vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({ left, right: left + width, width, top: 100, bottom: 300 } as DOMRect);
    }

    it('shifts right when the panel would spill off the left edge', () => {
      const spy = mockPanelRect(-128);
      try {
        const { container } = renderPopover();
        const panel = container.firstChild as HTMLElement;
        expect(panel.style.transform).toBe('translateX(136px)'); // back to the 8px gutter
      } finally {
        spy.mockRestore();
      }
    });

    it('shifts left when the panel would spill off the right edge', () => {
      const spy = mockPanelRect(window.innerWidth - 200);
      try {
        const { container } = renderPopover();
        const panel = container.firstChild as HTMLElement;
        expect(panel.style.transform).toBe('translateX(-64px)');
      } finally {
        spy.mockRestore();
      }
    });

    it('stays put when it already fits', () => {
      const spy = mockPanelRect(20);
      try {
        const { container } = renderPopover();
        const panel = container.firstChild as HTMLElement;
        expect(panel.style.transform).toBe('');
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('renders the current cadence presets and a custom option', () => {
    renderPopover();
    expect(screen.getByText('20h')).toBeInTheDocument();
    expect(screen.getByText('6 days')).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText('12 weeks')).toBeInTheDocument();
    expect(screen.getByText('custom')).toBeInTheDocument();
  });

  it('Snooze re-snoozes for the chosen cadence without logging the note', async () => {
    const { user, task } = renderPopover();
    await user.type(screen.getByPlaceholderText('What came of it?'), 'spoke to ops');
    await user.click(screen.getByText('30 days'));
    await user.click(screen.getByText('Snooze'));

    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
    const [id, payload] = mockUpdateTask.mock.calls[0];
    expect(id).toBe(task.id);
    expect(payload.snoozeCadence).toBe('30d');
    expect(payload.pingCooldown).toBe('custom');
    expect(payload.discussionLog).toBeUndefined();
    expect(payload.pingCooldownUntil).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(payload.pingCooldownUntil).toBeLessThan(Date.now() + 31 * DAY);
  });

  it('Log appends the note without snoozing', async () => {
    const { user, task } = renderPopover();
    await user.type(screen.getByPlaceholderText('What came of it?'), 'spoke to ops');
    await user.click(screen.getByText('Log'));

    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
    const [id, payload] = mockUpdateTask.mock.calls[0];
    expect(id).toBe(task.id);
    expect(payload.discussionLog).toHaveLength(1);
    expect(payload.discussionLog[0].note).toBe('spoke to ops');
    expect(payload.pingedAt).toBeUndefined();
    expect(payload.pingCooldownUntil).toBeUndefined();
    expect(payload.snoozeCadence).toBeUndefined();
  });

  it('Log is disabled while the note is empty', () => {
    renderPopover();
    expect(screen.getByText('Log')).toBeDisabled();
  });

  it('Enter in the note field logs the note without re-snoozing', async () => {
    const { user, task } = renderPopover();
    await user.type(screen.getByPlaceholderText('What came of it?'), 'noted via enter{Enter}');

    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
    const [id, payload] = mockUpdateTask.mock.calls[0];
    expect(id).toBe(task.id);
    expect(payload.discussionLog).toHaveLength(1);
    expect(payload.discussionLog[0].note).toBe('noted via enter');
    expect(payload.pingedAt).toBeUndefined();
    expect(payload.pingCooldownUntil).toBeUndefined();
    expect(payload.snoozeCadence).toBeUndefined();
  });

  it('Enter with an empty note logs nothing', async () => {
    const { user } = renderPopover();
    await user.type(screen.getByPlaceholderText('What came of it?'), '{Enter}');
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });


  it('custom reveals a date picker and snoozes until that date', async () => {
    const { user, task, container } = renderPopover();
    await user.click(screen.getByText('custom'));
    const input = container.querySelector('input[type="date"]');
    expect(input).toBeTruthy();
    await act(async () => {
      fireEvent.change(input!, { target: { value: '2099-06-22' } });
    });
    await user.click(screen.getByText('Snooze'));

    const [id, payload] = mockUpdateTask.mock.calls[0];
    expect(id).toBe(task.id);
    expect(payload.snoozeCadence).toBe('custom');
    expect(payload.snoozeCadenceDays).toBeGreaterThan(0);
    expect(payload.pingCooldownUntil).toBe(new Date(2099, 5, 22, 23, 59, 59, 999).getTime());
  });

  it('clicking the custom date field opens the native picker', async () => {
    const showPicker = vi.fn();
    HTMLInputElement.prototype.showPicker = showPicker as unknown as () => void;
    try {
      const { user, container } = renderPopover();
      await user.click(screen.getByText('custom'));
      const input = container.querySelector('input[type="date"]') as HTMLInputElement;
      await user.click(input);
      expect(showPicker).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(HTMLInputElement.prototype, 'showPicker');
    }
  });

  it('Escape closes it without logging or snoozing — from the note or a cadence chip', async () => {
    const task = makeTask('fu-1');
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<DiscussedPopover task={task} align="right" onDone={onDone} />);
    await user.type(screen.getByPlaceholderText('What came of it?'), 'half a thought{Escape}');
    expect(onDone).toHaveBeenCalledTimes(1);

    screen.getByText('30 days').focus();
    await user.keyboard('{Escape}');
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });
});
