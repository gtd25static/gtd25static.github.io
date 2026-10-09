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

describe('FollowUpList — sort by date and the add form', () => {
  beforeEach(() => {
    resetAppState();
    resetFactories();
    vi.clearAllMocks();
  });

  const titlesInOrder = () =>
    screen.getAllByText(/^(Later|Undated|Sooner|Snoozed)$/).map((el) => el.textContent);

  // The menu item was wired to nothing.
  it('"Sort by date" orders by due date, undated after, snoozed still last; again turns it off', async () => {
    setFollowUps([
      makeTask(fuList.id, { title: 'Later', dueDate: Date.now() + 5 * DAY_MS, order: 3 }),
      makeTask(fuList.id, { title: 'Undated', order: 2 }),
      makeTask(fuList.id, { title: 'Sooner', dueDate: Date.now() + DAY_MS, order: 1 }),
      { ...snoozedTask('Snoozed'), dueDate: Date.now(), order: 0 },
    ]);
    const { user, container } = renderList();
    await user.click(screen.getByRole('button', { name: /show snoozed/i }));
    const before = titlesInOrder();

    await user.click(container.querySelector('[data-dropdown-trigger]')!);
    await user.click(screen.getByText('Sort by date'));
    expect(titlesInOrder()).toEqual(['Sooner', 'Later', 'Undated', 'Snoozed']);

    await user.click(container.querySelector('[data-dropdown-trigger]')!);
    await user.click(screen.getByText('Sort by date ✓'));
    expect(titlesInOrder()).toEqual(before);
  });

  // Follow-ups have no done state for a recurrence to reset from.
  it('the add form offers no recurrence', async () => {
    setFollowUps([]);
    const { user } = renderList();
    await user.click(screen.getByText('Add a follow-up'));
    await user.click(screen.getByText(/^\+ description, link, due date/));
    expect(screen.getByLabelText('Due date')).toBeInTheDocument();
    expect(screen.queryByText('Recurring')).toBeNull();
    expect(screen.queryByText(/recurrence/)).toBeNull();
  });
});

describe('FollowUpList — the view is remembered, and topics wake on their own', () => {
  beforeEach(() => {
    resetAppState();
    resetFactories();
    vi.clearAllMocks();
  });

  // Show snoozed, the Resolved section and the order were local state: leaving
  // the list (or a search) reset them every time.
  it('keeps Show snoozed, Resolved and the order after leaving the list and coming back', async () => {
    setFollowUps(
      [makeTask(fuList.id, { title: 'Awake topic' }), snoozedTask('Snoozed topic')],
      [makeTask(fuList.id, { title: 'Resolved topic', archived: true })],
    );
    const first = renderList();
    await first.user.click(screen.getByRole('button', { name: /show snoozed/i }));
    await first.user.click(screen.getByRole('button', { name: /resolved \(1\)/i }));
    await first.user.click(first.container.querySelector('[data-dropdown-trigger]')!);
    await first.user.click(screen.getByText('Sort by date'));
    first.unmount();

    const second = renderList();
    expect(screen.getByText('Snoozed topic')).toBeInTheDocument();
    expect(screen.getByText('Resolved topic')).toBeInTheDocument();
    await second.user.click(second.container.querySelector('[data-dropdown-trigger]')!);
    expect(screen.getByText('Sort by date ✓')).toBeInTheDocument();
  });

  it('a snoozed topic appears when it wakes, without anything else changing', async () => {
    setFollowUps([
      makeTask(fuList.id, { title: 'Awake topic' }),
      makeTask(fuList.id, { title: 'Waking topic', pingedAt: Date.now(), pingCooldown: 'custom', pingCooldownUntil: Date.now() + 300 }),
    ]);
    renderList();
    expect(screen.queryByText('Waking topic')).not.toBeInTheDocument();
    expect(await screen.findByText('Waking topic', {}, { timeout: 3_000 })).toBeInTheDocument();
  });
});

describe('FollowUpList — "Stalest first"', () => {
  beforeEach(() => {
    resetAppState();
    resetFactories();
    vi.clearAllMocks();
    localStorage.removeItem('gtd25-follow-up-stalest');
  });

  const old = Date.now() - 30 * DAY_MS;
  const topics = () => [
    makeTask(fuList.id, { title: 'Talked today', order: 3, createdAt: old, discussionLog: [{ id: 'a', at: Date.now() }] }),
    makeTask(fuList.id, { title: 'Talked last month', order: 2, createdAt: old, discussionLog: [{ id: 'b', at: old + DAY_MS }] }),
    // A Discussed (snooze) a week ago that was unsnoozed counts as handled then.
    makeTask(fuList.id, { title: 'Discussed last week', order: 1, createdAt: old, pingedAt: Date.now() - 7 * DAY_MS }),
    makeTask(fuList.id, { title: 'Never talked', order: 0, createdAt: Date.now() - 10 * DAY_MS }),
  ];
  const titlesInOrder = () =>
    screen.getAllByText(/^(Talked today|Talked last month|Discussed last week|Never talked)$/).map((el) => el.textContent);
  const stalestChip = () => screen.getByRole('button', { name: 'Stalest first' });

  it('a chip in the header puts the topic left longest first, and back to the order by hand', async () => {
    setFollowUps(topics());
    const { user } = renderList();
    const byHand = titlesInOrder();
    expect(stalestChip()).toHaveAttribute('aria-pressed', 'false');

    await user.click(stalestChip());
    expect(stalestChip()).toHaveAttribute('aria-pressed', 'true');
    expect(titlesInOrder()).toEqual(['Talked last month', 'Never talked', 'Discussed last week', 'Talked today']);

    await user.click(stalestChip());
    expect(titlesInOrder()).toEqual(byHand);
  });

  it('is shown even with every topic awake, and the list menu no longer has its own copy', async () => {
    setFollowUps(topics());
    const { user, container } = renderList();
    expect(stalestChip()).toBeInTheDocument();
    await user.click(container.querySelector('[data-dropdown-trigger]')!);
    expect(screen.getByText('Sort by date')).toBeInTheDocument();
    expect(screen.queryByText(/last discussed/i)).not.toBeInTheDocument();
  });

  it('is remembered on this device and applies to every follow-up list', async () => {
    setFollowUps(topics());
    const first = renderList();
    await first.user.click(stalestChip());
    first.unmount();
    expect(localStorage.getItem('gtd25-follow-up-stalest')).toBe('1');

    renderWithDnd(<FollowUpList listId="fu-2" listName="Another list" />);
    expect(stalestChip()).toHaveAttribute('aria-pressed', 'true');
    expect(titlesInOrder()[0]).toBe('Talked last month');
  });

  it('"Sort by date" turns it off: one order at a time, the one just picked', async () => {
    setFollowUps([
      makeTask(fuList.id, { title: 'Later', dueDate: Date.now() + 5 * DAY_MS, order: 1, createdAt: old }),
      makeTask(fuList.id, { title: 'Sooner', dueDate: Date.now() + DAY_MS, order: 0, createdAt: Date.now() }),
    ]);
    const { user, container } = renderList();
    await user.click(stalestChip());
    expect(screen.getAllByText(/^(Later|Sooner)$/).map((el) => el.textContent)).toEqual(['Later', 'Sooner']);

    await user.click(container.querySelector('[data-dropdown-trigger]')!);
    await user.click(screen.getByText('Sort by date'));
    expect(stalestChip()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getAllByText(/^(Later|Sooner)$/).map((el) => el.textContent)).toEqual(['Sooner', 'Later']);
  });
});
