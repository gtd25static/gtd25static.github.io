// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import '../setup-component';
import {
  resetAppState,
  resetFactories,
  makeTask,
  makeTaskList,
  renderWithDnd,
} from '../helpers/component-helpers';
import { FollowUpList } from '../../components/follow-ups/FollowUpList';
import { useFollowUps } from '../../hooks/use-follow-ups';
import type { Task } from '../../db/models';

const fuList = makeTaskList({ id: 'fu-1', name: 'Follow Ups', type: 'follow-ups' });

// Keep the real cooldown helpers (so `isInCooldown` / `sortFollowUpsForDisplay`
// classify the fixtures for real); only stub the data hook.
vi.mock('../../hooks/use-follow-ups', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/use-follow-ups')>();
  return { ...actual, useFollowUps: vi.fn() };
});

// Mocked away to keep this a list-level test: render just the title so we can
// assert which entries are visible without the card's internals.
vi.mock('../../components/follow-ups/FollowUpCard', () => ({
  FollowUpCard: ({ task }: { task: Task }) => <div>{task.title}</div>,
}));

vi.mock('../../hooks/use-tasks', () => ({
  createTask: vi.fn(),
  reorderTasks: vi.fn(),
}));

const mockUseFollowUps = vi.mocked(useFollowUps);

const DAY_MS = 24 * 60 * 60 * 1000;

function snoozedTask(title: string): Task {
  return makeTask(fuList.id, {
    title,
    pingedAt: Date.now(),
    pingCooldown: 'custom',
    pingCooldownUntil: Date.now() + DAY_MS,
  });
}

function setFollowUps(active: Task[], archived: Task[] = []) {
  mockUseFollowUps.mockReturnValue({ active, archived });
}

function renderList() {
  return renderWithDnd(<FollowUpList listId={fuList.id} listName={fuList.name} />);
}

describe('FollowUpList — show/hide snoozed toggle', () => {
  beforeEach(() => {
    resetAppState();
    resetFactories();
    vi.clearAllMocks();
  });

  it('hides snoozed entries by default and shows only awake ones', () => {
    setFollowUps(
      [makeTask(fuList.id, { title: 'Awake topic' }), snoozedTask('Snoozed topic')],
      [makeTask(fuList.id, { title: 'Resolved topic', archived: true })],
    );
    renderList();

    expect(screen.getByText('Awake topic')).toBeInTheDocument();
    expect(screen.queryByText('Snoozed topic')).not.toBeInTheDocument();
    // Resolved lives in its own collapsed section — never surfaced by this toggle.
    expect(screen.queryByText('Resolved topic')).not.toBeInTheDocument();
  });

  it('shows a toggle button with the snoozed count only when snoozed entries exist', () => {
    setFollowUps([makeTask(fuList.id, { title: 'Awake topic' })]);
    const { unmount } = renderList();
    expect(screen.queryByRole('button', { name: /snoozed/i })).not.toBeInTheDocument();
    unmount();

    setFollowUps([
      makeTask(fuList.id, { title: 'Awake topic' }),
      snoozedTask('Snoozed A'),
      snoozedTask('Snoozed B'),
    ]);
    renderList();
    expect(screen.getByRole('button', { name: /show snoozed \(2\)/i })).toBeInTheDocument();
  });

  it('reveals snoozed entries on click and hides them again on a second click', async () => {
    setFollowUps([
      makeTask(fuList.id, { title: 'Awake topic' }),
      snoozedTask('Snoozed topic'),
    ]);
    const { user } = renderList();

    await user.click(screen.getByRole('button', { name: /show snoozed \(1\)/i }));
    expect(screen.getByText('Snoozed topic')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide snoozed \(1\)/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /hide snoozed \(1\)/i }));
    expect(screen.queryByText('Snoozed topic')).not.toBeInTheDocument();
  });

  it('never surfaces archived/resolved entries, even with snoozed shown', async () => {
    setFollowUps(
      [makeTask(fuList.id, { title: 'Awake topic' }), snoozedTask('Snoozed topic')],
      [makeTask(fuList.id, { title: 'Resolved topic', archived: true })],
    );
    const { user } = renderList();

    await user.click(screen.getByRole('button', { name: /show snoozed/i }));
    expect(screen.getByText('Snoozed topic')).toBeInTheDocument();
    expect(screen.queryByText('Resolved topic')).not.toBeInTheDocument();
  });

  it('shows an "all snoozed" empty state when every active entry is snoozed', () => {
    setFollowUps([snoozedTask('Snoozed only')]);
    renderList();

    expect(screen.queryByText('Snoozed only')).not.toBeInTheDocument();
    expect(screen.getByText('All follow-ups are snoozed')).toBeInTheDocument();
  });
});
