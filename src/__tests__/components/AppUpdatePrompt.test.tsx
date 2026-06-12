// @vitest-environment jsdom
//
// The update prompt is a plain fixed overlay, so top-layer dialogs (showModal)
// would paint above and block it. These tests pin the dismissal behavior: open
// modal dialogs are closed when the prompt appears AND while it stays visible,
// but not once it is demoted to the "Later" banner.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { AppUpdatePrompt } from '../../components/banners/AppUpdatePrompt';

vi.mock('../../hooks/use-service-worker', () => ({
  useServiceWorker: () => ({
    needRefresh: true,
    applyUpdate: vi.fn(),
    checkForUpdate: vi.fn(),
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

function openModalDialog(): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  document.body.appendChild(dlg);
  dlg.showModal();
  return dlg;
}

describe('AppUpdatePrompt — takes precedence over open dialogs', () => {
  beforeEach(() => {
    localStorage.clear();
    // version.json fetch: not deployed — prompt shows without changelog info.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelectorAll('dialog').forEach((d) => d.remove());
  });

  it('closes a modal dialog that was open when the prompt appears', async () => {
    const dlg = openModalDialog();
    render(<AppUpdatePrompt />);
    await screen.findByText('Update available');
    expect(dlg.hasAttribute('open')).toBe(false);
  });

  it('closes modal dialogs that open while the prompt is visible', async () => {
    render(<AppUpdatePrompt />);
    await screen.findByText('Update available');

    const dlg = openModalDialog();
    await waitFor(() => expect(dlg.hasAttribute('open')).toBe(false));
  });

  it('dispatches the dialog close event so React onClose handlers run', async () => {
    render(<AppUpdatePrompt />);
    await screen.findByText('Update available');

    const dlg = openModalDialog();
    const onClose = vi.fn();
    dlg.addEventListener('close', onClose);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('leaves dialogs alone once demoted to the "Later" banner', async () => {
    const user = userEvent.setup();
    render(<AppUpdatePrompt />);
    await screen.findByText('Update available');
    await user.click(screen.getByRole('button', { name: 'Later' }));

    const dlg = openModalDialog();
    // Give a buggy (not disconnected) observer time to mis-fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(dlg.hasAttribute('open')).toBe(true);
  });
});
