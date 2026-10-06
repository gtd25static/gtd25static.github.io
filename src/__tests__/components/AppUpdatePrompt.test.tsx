// @vitest-environment jsdom
//
// The update prompt is a plain fixed overlay, so top-layer dialogs (showModal)
// would paint above and block it. It used to close them — an Edit Task dialog
// with its unsaved text included (reliability review 2026-10-06, A3). Now an
// open dialog is never touched: the prompt waits as the top banner while one is
// open and comes back as the dialog when it closes.
import { render, screen } from '@testing-library/react';
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

const bannerText = 'A new version of GTD25 is available.';

describe('AppUpdatePrompt — never closes an open dialog', () => {
  beforeEach(() => {
    localStorage.clear();
    // version.json fetch: not deployed — prompt shows without changelog info.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelectorAll('dialog').forEach((d) => d.remove());
  });

  it('a dialog open when the update arrives stays open, and the prompt waits as the banner', async () => {
    const dlg = openModalDialog();
    const onClose = vi.fn();
    dlg.addEventListener('close', onClose);
    render(<AppUpdatePrompt />);

    await screen.findByText(bannerText);
    await new Promise((r) => setTimeout(r, 50));
    expect(dlg.hasAttribute('open')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('Update available')).not.toBeInTheDocument();
  });

  it('the prompt comes back as the dialog once the open dialog closes', async () => {
    const dlg = openModalDialog();
    render(<AppUpdatePrompt />);
    await screen.findByText(bannerText);

    dlg.close();

    expect(await screen.findByText('Update available')).toBeInTheDocument();
  });

  it('a dialog opened while the prompt is shown stays open; the prompt steps back to the banner', async () => {
    render(<AppUpdatePrompt />);
    await screen.findByText('Update available');

    const dlg = openModalDialog();

    await screen.findByText(bannerText);
    expect(dlg.hasAttribute('open')).toBe(true);
  });

  it('"Later" still demotes it to the banner for good', async () => {
    const user = userEvent.setup();
    render(<AppUpdatePrompt />);
    await screen.findByText('Update available');
    await user.click(screen.getByRole('button', { name: 'Later' }));

    const dlg = openModalDialog();
    dlg.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Update available')).not.toBeInTheDocument();
    expect(screen.getByText(bannerText)).toBeInTheDocument();
  });
});
