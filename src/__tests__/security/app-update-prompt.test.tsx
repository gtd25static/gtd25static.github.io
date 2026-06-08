// @vitest-environment jsdom
import { vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';

// Controllable mocks for the SW hook and the sync-engine version events.
const h = vi.hoisted(() => ({
  sw: { needRefresh: true, applyUpdate: vi.fn(), checkForUpdate: vi.fn(), forceCheck: vi.fn() },
  incompatHandlers: [] as Array<() => void>,
}));
vi.mock('../../hooks/use-service-worker', () => ({ useServiceWorker: () => h.sw }));
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

beforeEach(() => {
  h.sw.needRefresh = true;
  h.sw.applyUpdate = vi.fn();
  h.sw.forceCheck = vi.fn();
  h.incompatHandlers.length = 0;
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
