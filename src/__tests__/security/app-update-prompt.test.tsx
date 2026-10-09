// @vitest-environment jsdom
import { vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';

// Controllable mocks for the SW hook and the sync-engine version events.
const h = vi.hoisted(() => ({
  sw: { needRefresh: true, applyUpdate: vi.fn(), checkForUpdate: vi.fn(), forceCheck: vi.fn() },
  vault: { enabled: false, unlocked: false, locked: false, hasSecurityKey: false },
  incompatHandlers: [] as Array<() => void>,
  toast: vi.fn(),
  safe: false,
}));
vi.mock('../../lib/locked-update', () => ({ safeToUpdateWhileLocked: async () => h.safe }));
vi.mock('../../components/ui/Toast', () => ({ toast: h.toast }));
vi.mock('../../hooks/use-service-worker', () => ({ useServiceWorker: () => h.sw }));
vi.mock('../../hooks/use-vault', () => ({ useVault: () => h.vault }));
vi.mock('../../sync/sync-engine', () => ({
  onVersionIncompatible: (cb: () => void) => { h.incompatHandlers.push(cb); },
  offVersionIncompatible: () => {},
  onSyncSuccess: () => {},
  offSyncSuccess: () => {},
}));

import { AppUpdatePrompt } from '../../components/banners/AppUpdatePrompt';

// GIT_COMMIT is 'dev' under vitest; put it in the log so the cutoff is exercised.
const VERSION_JSON = {
  commit: 'new1',
  message: 'New thing',
  log: [{ h: 'new1', s: 'New thing' }, { h: 'dev', s: 'current' }],
};
const PARANOID_UPDATE_NOTICE_KEY = 'gtd25-paranoid-update-notice';

beforeEach(() => {
  h.sw.needRefresh = true;
  h.sw.applyUpdate = vi.fn();
  h.sw.forceCheck = vi.fn();
  h.vault = { enabled: false, unlocked: false, locked: false, hasSecurityKey: false };
  h.incompatHandlers.length = 0;
  h.safe = false;
  localStorage.removeItem(PARANOID_UPDATE_NOTICE_KEY);
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => VERSION_JSON,
  }) as unknown as typeof fetch;
});

afterEach(() => { vi.restoreAllMocks(); });

describe('AppUpdatePrompt', () => {
  it('renders nothing when there is no update', () => {
    h.sw.needRefresh = false;
    const { container } = render(<AppUpdatePrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the dialog with the changelog of commits newer than the current build', async () => {
    render(<AppUpdatePrompt />);
    expect(await screen.findByText('Update available')).toBeInTheDocument();
    expect(await screen.findByText('New thing')).toBeInTheDocument(); // fetched changelog
    expect(screen.queryByText('current')).not.toBeInTheDocument();    // stops at current (dev)
  });

  it('reads the changelog from changes.json, not from the version file the background check polls', async () => {
    render(<AppUpdatePrompt />);
    expect(await screen.findByText('New thing')).toBeInTheDocument();
    const urls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.includes('changes.json'))).toBe(true);
    expect(urls.some((u) => u.includes('version.json'))).toBe(false);
  });

  it('"Update now" applies the update', async () => {
    const user = userEvent.setup();
    render(<AppUpdatePrompt />);
    await screen.findByText('Update available');
    await user.click(screen.getByRole('button', { name: /update now/i }));
    expect(h.sw.applyUpdate).toHaveBeenCalled();
  });

  it('defers updates while a Paranoid vault is unlocked', async () => {
    const user = userEvent.setup();
    h.vault = { enabled: true, unlocked: true, locked: false, hasSecurityKey: false };
    const { rerender } = render(<AppUpdatePrompt />);
    await screen.findByText('Update available');

    await user.click(screen.getByRole('button', { name: /update when locked/i }));

    expect(h.sw.applyUpdate).not.toHaveBeenCalled();
    expect(screen.getByText('Update queued. It will install after the vault locks.')).toBeInTheDocument();

    h.vault = { enabled: true, unlocked: false, locked: true, hasSecurityKey: false };
    h.safe = true;
    rerender(<AppUpdatePrompt />);

    await waitFor(() => expect(h.sw.applyUpdate).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem(PARANOID_UPDATE_NOTICE_KEY) ?? '{}')).toMatchObject({
      from: 'dev',
      to: 'new1',
    });
  });

  // The modal sat above the lock screen and looked the same whether the vault had
  // locked under it or not: a Mac woken after hours showed it over an unlocked app.
  it('over a locked vault it is the top banner, so the lock screen stays in view', async () => {
    const user = userEvent.setup();
    h.vault = { enabled: true, unlocked: false, locked: true, hasSecurityKey: false };
    render(<AppUpdatePrompt />);
    expect(await screen.findByText('A new version of GTD25 is available.')).toBeInTheDocument();
    expect(screen.queryByText('Update available')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /update now/i }));
    expect(h.sw.applyUpdate).toHaveBeenCalled();
  });

  it('the dialog shown over an unlocked vault becomes the banner when the vault locks', async () => {
    h.vault = { enabled: true, unlocked: true, locked: false, hasSecurityKey: false };
    const { rerender } = render(<AppUpdatePrompt />);
    await screen.findByText('Update available');
    h.vault = { enabled: true, unlocked: false, locked: true, hasSecurityKey: false };
    rerender(<AppUpdatePrompt />);
    expect(screen.queryByText('Update available')).not.toBeInTheDocument();
    expect(screen.getByText('A new version of GTD25 is available.')).toBeInTheDocument();
  });

  it('shows a post-update Paranoid notice after the build changes', () => {
    h.sw.needRefresh = false;
    localStorage.setItem(PARANOID_UPDATE_NOTICE_KEY, JSON.stringify({
      from: 'old1',
      to: 'dev',
      at: Date.now(),
    }));

    render(<AppUpdatePrompt />);

    expect(screen.getByText('GTD25 updated. Your Paranoid vault is locked for safety.')).toBeInTheDocument();
    expect(localStorage.getItem(PARANOID_UPDATE_NOTICE_KEY)).toBeNull();
  });

  it('auto-dismisses the post-update notice after 5s, with a filling Dismiss button', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      h.sw.needRefresh = false;
      localStorage.setItem(PARANOID_UPDATE_NOTICE_KEY, JSON.stringify({ from: 'old1', to: 'dev', at: Date.now() }));

      render(<AppUpdatePrompt />);
      const notice = 'GTD25 updated. Your Paranoid vault is locked for safety.';
      expect(screen.getByText(notice)).toBeInTheDocument();

      // The Dismiss button carries the 5s fill animation as the visual countdown.
      const fill = screen.getByRole('button', { name: 'Dismiss' }).querySelector('[style*="update-notice-fill"]');
      expect(fill).not.toBeNull();

      act(() => { vi.advanceTimersByTime(4999); });
      expect(screen.getByText(notice)).toBeInTheDocument();          // still up just before the deadline
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.queryByText(notice)).not.toBeInTheDocument();     // gone when the fill completes
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets you dismiss the post-update notice immediately', () => {
    h.sw.needRefresh = false;
    localStorage.setItem(PARANOID_UPDATE_NOTICE_KEY, JSON.stringify({ from: 'old1', to: 'dev', at: Date.now() }));

    render(<AppUpdatePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('GTD25 updated. Your Paranoid vault is locked for safety.')).not.toBeInTheDocument();
  });

  it('does not show the post-update Paranoid notice before the build changes', () => {
    h.sw.needRefresh = false;
    localStorage.setItem(PARANOID_UPDATE_NOTICE_KEY, JSON.stringify({
      from: 'dev',
      to: 'new1',
      at: Date.now(),
    }));

    const { container } = render(<AppUpdatePrompt />);

    expect(container).toBeEmptyDOMElement();
    expect(localStorage.getItem(PARANOID_UPDATE_NOTICE_KEY)).not.toBeNull();
  });

  it('"Later" dismisses the dialog and falls back to a top banner', async () => {
    const user = userEvent.setup();
    render(<AppUpdatePrompt />);
    await screen.findByText('Update available');
    await user.click(screen.getByRole('button', { name: /later/i }));
    expect(screen.queryByText('Update available')).not.toBeInTheDocument(); // dialog title gone
    expect(screen.getByRole('button', { name: /update now/i })).toBeInTheDocument(); // banner remains
  });

  it('suppresses same-commit service worker update signals', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        commit: 'dev',
        message: 'current',
        log: [{ h: 'dev', s: 'current' }],
      }),
    }) as unknown as typeof fetch;

    const { container } = render(<AppUpdatePrompt />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByRole('button', { name: /update now/i })).not.toBeInTheDocument();
    expect(screen.queryByText('dev → dev')).not.toBeInTheDocument();
  });

  it('shows "Update required" for a sync-incompatible version', async () => {
    h.sw.needRefresh = false;
    render(<AppUpdatePrompt />);
    expect(screen.queryByText('Update required')).not.toBeInTheDocument();
    act(() => { h.incompatHandlers.forEach((cb) => cb()); });
    expect(await screen.findByText('Update required')).toBeInTheDocument();
    expect(h.sw.forceCheck).toHaveBeenCalled(); // forces an immediate SW check
  });

  it('defers sync-required reloads while a Paranoid vault is unlocked', async () => {
    const user = userEvent.setup();
    h.sw.needRefresh = false;
    h.vault = { enabled: true, unlocked: true, locked: false, hasSecurityKey: false };
    render(<AppUpdatePrompt />);

    act(() => { h.incompatHandlers.forEach((cb) => cb()); });
    expect(await screen.findByText('Update required')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /update when locked/i }));

    expect(screen.getByText('Update queued. It will install after the vault locks.')).toBeInTheDocument();
    expect(h.sw.applyUpdate).not.toHaveBeenCalled();
  });

  // Reliability review 2026-10-06 (B16): with no new build waiting, "Update now"
  // was a bare reload — into the same build.
  it('"Update now" with nothing waiting looks for the update instead of reloading into the same build', async () => {
    const user = userEvent.setup();
    h.sw.needRefresh = false;
    h.sw.forceCheck = vi.fn(async () => 'up-to-date');
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    try {
      render(<AppUpdatePrompt />);
      act(() => { h.incompatHandlers.forEach((cb) => cb()); });
      await user.click(await screen.findByRole('button', { name: /update now/i }));

      await waitFor(() => expect(h.sw.forceCheck).toHaveBeenCalledTimes(2)); // on the event, and on the tap
      expect(reload).not.toHaveBeenCalled();
      await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/No newer version is published/), 'error'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not render an equal commit range for sync-incompatible metadata', async () => {
    h.sw.needRefresh = false;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        commit: 'dev',
        message: 'current',
        log: [{ h: 'dev', s: 'current' }],
      }),
    }) as unknown as typeof fetch;

    render(<AppUpdatePrompt />);
    act(() => { h.incompatHandlers.forEach((cb) => cb()); });

    expect(await screen.findByText('Update required')).toBeInTheDocument();
    expect(await screen.findByText('Current commit dev')).toBeInTheDocument();
    expect(screen.queryByText('dev → dev')).not.toBeInTheDocument();
  });
});

describe('AppUpdatePrompt — a locked Paranoid vault updates on its own', () => {
  const LOCKED = { enabled: true, unlocked: false, locked: true, hasSecurityKey: false };
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

  it('applies a waiting update without a click when it is safe, and leaves the notice for after the reload', async () => {
    h.vault = LOCKED;
    h.safe = true;
    render(<AppUpdatePrompt />);
    await waitFor(() => expect(h.sw.applyUpdate).toHaveBeenCalledTimes(1));
    expect(JSON.parse(localStorage.getItem(PARANOID_UPDATE_NOTICE_KEY) ?? '{}')).toMatchObject({ from: 'dev', to: 'new1' });
  });

  it('while it is not safe it waits, with the banner and its "Update now", and applies once it is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      h.vault = LOCKED;
      render(<AppUpdatePrompt />);
      expect(await screen.findByText('A new version of GTD25 is available.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /update now/i })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
      expect(h.sw.applyUpdate).not.toHaveBeenCalled();

      h.safe = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(h.sw.applyUpdate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never unasked while the vault is open, nor without Paranoid Mode', async () => {
    h.safe = true;
    h.vault = { enabled: true, unlocked: true, locked: false, hasSecurityKey: false };
    const open = render(<AppUpdatePrompt />);
    await screen.findByText('Update available');
    await settle();
    open.unmount();
    h.vault = { enabled: false, unlocked: false, locked: false, hasSecurityKey: false };
    render(<AppUpdatePrompt />);
    await screen.findByText('Update available');
    await settle();
    expect(h.sw.applyUpdate).not.toHaveBeenCalled();
  });

  // An update that did not take (the same build after the reload) must not
  // reload the device over and over.
  it('not again within the hour after one that did not take, and again after it', async () => {
    h.vault = LOCKED;
    h.safe = true;
    localStorage.setItem(PARANOID_UPDATE_NOTICE_KEY, JSON.stringify({ from: 'dev', to: 'new1', at: Date.now() - 10 * 60_000 }));
    const first = render(<AppUpdatePrompt />);
    expect(await screen.findByText('A new version of GTD25 is available.')).toBeInTheDocument();
    await settle();
    expect(h.sw.applyUpdate).not.toHaveBeenCalled();
    first.unmount();

    localStorage.setItem(PARANOID_UPDATE_NOTICE_KEY, JSON.stringify({ from: 'dev', to: 'new1', at: Date.now() - 61 * 60_000 }));
    render(<AppUpdatePrompt />);
    await waitFor(() => expect(h.sw.applyUpdate).toHaveBeenCalledTimes(1));
  });

  // Required by sync, with no new build waiting yet: a reload would only rerun
  // this build. The regular check finds the build when it is published.
  it('required by sync with nothing waiting, it does not reload', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    try {
      h.sw.needRefresh = false;
      h.vault = LOCKED;
      h.safe = true;
      render(<AppUpdatePrompt />);
      act(() => { h.incompatHandlers.forEach((cb) => cb()); });
      expect(await screen.findByText('A newer version of GTD25 is required to sync.')).toBeInTheDocument();
      await settle();
      expect(reload).not.toHaveBeenCalled();
      expect(h.sw.applyUpdate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('AppUpdatePrompt — the post-update notice waits for you', () => {
  const NOTICE = 'GTD25 updated. Your Paranoid vault is locked for safety.';
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    h.sw.needRefresh = false;
    localStorage.setItem(PARANOID_UPDATE_NOTICE_KEY, JSON.stringify({ from: 'old1', to: 'dev', at: Date.now() }));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  const fill = () => screen.getByRole('button', { name: 'Dismiss' }).querySelector('[style*="update-notice-fill"]');

  it('stays put while the app is not in focus, and counts down once it is', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render(<AppUpdatePrompt />);
    expect(fill()).toBeNull(); // no countdown yet
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText(NOTICE)).toBeInTheDocument();

    hasFocus.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(fill()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(4_999); });
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('a hidden app counts as away, even with focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    visibility = 'hidden';
    render(<AppUpdatePrompt />);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(fill()).toBeNull();

    visibility = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fill()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('Dismiss still closes it at once, counting down or not', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render(<AppUpdatePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});
