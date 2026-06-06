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

  it('renders the current cadence presets and a custom option', () => {
    renderPopover();
    expect(screen.getByText('20h')).toBeInTheDocument();
    expect(screen.getByText('6 days')).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText('12 weeks')).toBeInTheDocument();
    expect(screen.getByText('custom')).toBeInTheDocument();
  });

  it('logs and re-snoozes for the chosen named cadence', async () => {
    const { user, task } = renderPopover();
    await user.click(screen.getByText('30 days'));
    await user.click(screen.getByText('Log & snooze'));

    expect(mockUpdateTask).toHaveBeenCalledTimes(1);
    const [id, payload] = mockUpdateTask.mock.calls[0];
    expect(id).toBe(task.id);
    expect(payload.snoozeCadence).toBe('30d');
    expect(payload.pingCooldown).toBe('custom');
    expect(payload.discussionLog).toHaveLength(1);
    expect(payload.pingCooldownUntil).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(payload.pingCooldownUntil).toBeLessThan(Date.now() + 31 * DAY);
  });

  it('custom reveals a date picker and snoozes until that date', async () => {
    const { user, task, container } = renderPopover();
    await user.click(screen.getByText('custom'));
    const input = container.querySelector('input[type="date"]');
    expect(input).toBeTruthy();
    await act(async () => {
      fireEvent.change(input!, { target: { value: '2099-06-22' } });
    });
    await user.click(screen.getByText('Log & snooze'));

    const [id, payload] = mockUpdateTask.mock.calls[0];
    expect(id).toBe(task.id);
    expect(payload.snoozeCadence).toBe('custom');
    expect(payload.snoozeCadenceDays).toBeGreaterThan(0);
    expect(payload.pingCooldownUntil).toBe(new Date(2099, 5, 22, 23, 59, 59, 999).getTime());
  });
});
