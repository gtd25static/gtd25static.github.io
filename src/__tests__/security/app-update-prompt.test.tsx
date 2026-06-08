// @vitest-environment jsdom
import { vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';

// Controllable mocks for the SW hook and the sync-engine version events.
const h = vi.hoisted(() => ({
  sw: { needRefresh: true, applyUpdate: vi.fn(), checkForUpdate: vi.fn(), forceCheck: vi.fn() },
  vault: { enabled: false, unlocked: false, locked: false, hasSecurityKey: false },
  incompatHandlers: [] as Array<() => void>,
}));
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
    rerender(<AppUpdatePrompt />);

    await waitFor(() => expect(h.sw.applyUpdate).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem(PARANOID_UPDATE_NOTICE_KEY) ?? '{}')).toMatchObject({
      from: 'dev',
      to: 'new1',
    });
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
