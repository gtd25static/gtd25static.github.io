// @vitest-environment jsdom
//
// On a trusted device you open the app to answer an unlock request: the update
// dialog must not be what you find. The update prompt shows nothing while the app
// looks for requests or while one is on screen, and looks for an update once
// that is over.
import { act, render, screen } from '@testing-library/react';
import '../setup-component';
import { AppUpdatePrompt } from '../../components/banners/AppUpdatePrompt';
import { setApprovalState, __resetApprovalGateForTests } from '../../lib/approval-gate';

const h = vi.hoisted(() => ({ checkForUpdate: vi.fn() }));

vi.mock('../../hooks/use-service-worker', () => ({
  useServiceWorker: () => ({
    needRefresh: true,
    applyUpdate: vi.fn(),
    checkForUpdate: h.checkForUpdate,
    forceCheck: vi.fn(),
  }),
}));
vi.mock('../../hooks/use-vault', () => ({
  useVault: () => ({ enabled: false, locked: false, unlocked: false }),
}));
vi.mock('../../sync/sync-engine', () => ({
  onVersionIncompatible: vi.fn(),
  offVersionIncompatible: vi.fn(),
  onSyncSuccess: vi.fn(),
  offSyncSuccess: vi.fn(),
}));

const title = () => screen.queryByRole('heading', { name: 'Update available' });

beforeEach(() => {
  localStorage.clear();
  h.checkForUpdate.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
});
afterEach(() => {
  vi.unstubAllGlobals();
  __resetApprovalGateForTests('idle');
});

it('waits while an unlock request is on screen, then shows and looks for an update', async () => {
  __resetApprovalGateForTests('request');
  render(<AppUpdatePrompt />);
  await new Promise((r) => setTimeout(r, 50));
  expect(title()).toBeNull();
  expect(screen.queryByText(/A new version of GTD25 is available/)).toBeNull(); // not even the banner
  expect(h.checkForUpdate).not.toHaveBeenCalled();

  act(() => setApprovalState('idle')); // approved or denied
  expect(await screen.findByRole('heading', { name: 'Update available' })).toBeInTheDocument();
  expect(h.checkForUpdate).toHaveBeenCalledTimes(1);
});

it('waits while the app looks for unlock requests', async () => {
  __resetApprovalGateForTests('checking');
  render(<AppUpdatePrompt />);
  await new Promise((r) => setTimeout(r, 50));
  expect(title()).toBeNull();

  act(() => setApprovalState('idle')); // none found
  expect(await screen.findByRole('heading', { name: 'Update available' })).toBeInTheDocument();
});

it('control: with nothing to wait for it shows at once', async () => {
  render(<AppUpdatePrompt />);
  expect(await screen.findByRole('heading', { name: 'Update available' })).toBeInTheDocument();
});
