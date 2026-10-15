// @vitest-environment jsdom
import { render } from '@testing-library/react';
import '../setup-component';
import { vi, beforeEach } from 'vitest';

// A capture launched at the INSTALLED app while a window of it is already open:
// the manifest's launch_handler (focus-existing) brings that window forward and
// hands the launch URL to window.launchQueue instead of opening a new window —
// which, in Paranoid Mode, started locked although this one was unlocked.

// Tracks how many captures are being filed at once: one at a time, or several
// could each create the Inbox.
let inFlight = 0;
let maxInFlight = 0;
const createTask = vi.fn(async (..._a: unknown[]): Promise<{ id: string } | undefined> => {
  maxInFlight = Math.max(maxInFlight, ++inFlight);
  await new Promise((r) => setTimeout(r, 1));
  inFlight--;
  return { id: 't1' };
});
vi.mock('../../hooks/use-tasks', () => ({ createTask: (...a: unknown[]) => createTask(...a) }));
vi.mock('../../hooks/use-task-lists', () => ({ getOrCreateInbox: () => Promise.resolve('inbox-id') }));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

const vault = { paranoid: false, unlocked: false, expireOnCheck: false };
const lockIfIdleExpired = vi.fn(() => { if (vault.expireOnCheck) vault.unlocked = false; });
vi.mock('../../db/vault', () => ({
  lockIfIdleExpired: () => lockIfIdleExpired(),
  isParanoidEnabled: () => vault.paranoid,
  isUnlocked: () => vault.unlocked,
}));

type Consumer = (params: { targetURL?: string }) => void;
let consumer: Consumer | null = null;

// The module keeps the queue and the boot launch in module state: a fresh copy per test.
async function load() {
  vi.resetModules();
  const mod = await import('../../hooks/use-url-capture');
  function Harness() { mod.useUrlCapture(); return null; }
  return { ...mod, Harness };
}

const payload = (title: string) => `web+gtd:capture?title=${encodeURIComponent(title)}&url=${encodeURIComponent('https://x.com/a')}`;
const launchUrl = (title: string) => `${window.location.origin}/?protocol=${encodeURIComponent(payload(title))}`;
const launch = (targetURL?: string) => consumer!({ targetURL });
const filedTitles = () => createTask.mock.calls.map((c) => (c[1] as { title: string }).title);

beforeEach(() => {
  createTask.mockClear();
  inFlight = 0;
  maxInFlight = 0;
  lockIfIdleExpired.mockClear();
  Object.assign(vault, { paranoid: false, unlocked: false, expireOnCheck: false });
  consumer = null;
  Object.defineProperty(window, 'launchQueue', {
    configurable: true,
    value: { setConsumer: (c: Consumer) => { consumer = c; } },
  });
  window.history.replaceState({}, '', '/');
});

describe('listenForLaunches — captures that reach an already open app window', () => {
  it('files a capture launched at the open, unlocked window at once', async () => {
    const { listenForLaunches, Harness } = await load();
    Object.assign(vault, { paranoid: true, unlocked: true });
    listenForLaunches();
    render(<Harness />);
    launch(launchUrl('Captured page'));
    await vi.waitFor(() => expect(filedTitles()).toEqual(['Captured page']));
    expect(createTask.mock.calls[0][1]).toMatchObject({ link: 'https://x.com/a' });
  });

  it('files the launch that opened this window once — the queue repeats it', async () => {
    const { listenForLaunches, takeCaptureFromUrl, Harness } = await load();
    window.history.replaceState({}, '', `/?protocol=${encodeURIComponent(payload('Opened with'))}`);
    takeCaptureFromUrl();
    listenForLaunches();
    render(<Harness />);
    launch(launchUrl('Opened with')); // the same launch, handed over again
    await vi.waitFor(() => expect(filedTitles()).toEqual(['Opened with']));
    // Capturing the same page again later is a new capture.
    launch(launchUrl('Opened with'));
    await vi.waitFor(() => expect(filedTitles()).toEqual(['Opened with', 'Opened with']));
  });

  it('keeps every capture that reaches a locked window, and files them on unlock', async () => {
    const { listenForLaunches, Harness } = await load();
    listenForLaunches();
    launch(launchUrl('First'));
    launch(launchUrl('Second'));
    await Promise.resolve();
    expect(createTask).not.toHaveBeenCalled(); // locked: the unlocked app isn't mounted
    render(<Harness />);
    await vi.waitFor(() => expect(filedTitles()).toEqual(['First', 'Second']));
  });

  it('a window brought forward after its idle time ran out locks first, and files the capture on unlock', async () => {
    const { listenForLaunches, Harness } = await load();
    Object.assign(vault, { paranoid: true, unlocked: true, expireOnCheck: true });
    listenForLaunches();
    const { unmount } = render(<Harness />);
    launch(launchUrl('Late'));
    await Promise.resolve();
    expect(lockIfIdleExpired).toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    unmount(); // the lock screen
    Object.assign(vault, { unlocked: true, expireOnCheck: false });
    render(<Harness />);
    await vi.waitFor(() => expect(filedTitles()).toEqual(['Late']));
  });

  it('files captures one at a time, oldest first', async () => {
    const { listenForLaunches, Harness } = await load();
    listenForLaunches();
    for (const t of ['A', 'B', 'C']) launch(launchUrl(t));
    render(<Harness />);
    launch(launchUrl('D'));
    await vi.waitFor(() => expect(filedTitles()).toEqual(['A', 'B', 'C', 'D']));
    expect(maxInFlight).toBe(1);
  });

  it('a capture whose write met a lock is kept for the next unlock', async () => {
    const { listenForLaunches, Harness } = await load();
    Object.assign(vault, { paranoid: true, unlocked: true });
    listenForLaunches();
    const { unmount } = render(<Harness />);
    // Locks while the write is under way: the vault fails it closed.
    createTask.mockImplementationOnce(async () => { vault.unlocked = false; return undefined; });
    launch(launchUrl('Raced'));
    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    unmount();
    vault.unlocked = true;
    render(<Harness />);
    await vi.waitFor(() => expect(filedTitles()).toEqual(['Raced', 'Raced']));
  });

  it('holds at most 20 captures while locked', async () => {
    const { listenForLaunches, Harness } = await load();
    listenForLaunches();
    for (let i = 0; i < 25; i++) launch(launchUrl(`P${i}`));
    render(<Harness />);
    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(20));
    await new Promise((r) => setTimeout(r, 20));
    expect(createTask).toHaveBeenCalledTimes(20);
  });

  it('takes a captured https link to the app (link capturing) like the protocol launch', async () => {
    const { listenForLaunches, Harness } = await load();
    listenForLaunches();
    render(<Harness />);
    launch(`${window.location.origin}/?capture&title=Linked&url=${encodeURIComponent('https://x.com/a')}`);
    await vi.waitFor(() => expect(filedTitles()).toEqual(['Linked']));
  });

  it('a first launch with no URL does not make a later identical capture be skipped', async () => {
    const { listenForLaunches, takeCaptureFromUrl, Harness } = await load();
    window.history.replaceState({}, '', `/?protocol=${encodeURIComponent(payload('Same'))}`);
    takeCaptureFromUrl();
    listenForLaunches();
    render(<Harness />);
    launch(undefined); // the opening launch, delivered without its URL
    launch(launchUrl('Same')); // the user captures the same page again
    await vi.waitFor(() => expect(filedTitles()).toEqual(['Same', 'Same']));
  });

  it('ignores launches that carry no capture, or name another site', async () => {
    const { listenForLaunches, Harness } = await load();
    listenForLaunches();
    render(<Harness />);
    launch(`${window.location.origin}/`); // a plain launch of the app
    launch(`https://evil.example/?protocol=${encodeURIComponent(payload('X'))}`);
    launch(undefined);
    launch('not a url');
    await Promise.resolve();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('does nothing in a browser without a launch queue', async () => {
    const { listenForLaunches } = await load();
    Reflect.deleteProperty(window, 'launchQueue');
    expect(() => listenForLaunches()).not.toThrow();
  });
});
