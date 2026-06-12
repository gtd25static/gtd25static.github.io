// @vitest-environment jsdom
//
// Guards the prompt-wall on "Wipe All Data": the destructive wipeAllData()
// call must stay behind the typed ("yes") confirmation. Drives the real
// ConfirmDialog rather than mocking it, so removing typeToConfirm from the
// button would fail these tests.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { BackupsSettings } from '../../components/settings/BackupsSettings';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';

const h = vi.hoisted(() => ({
  wipeAllData: vi.fn(),
  local: {} as Record<string, unknown>,
}));

vi.mock('../../hooks/use-settings', () => ({
  useLocalSettings: () => h.local,
}));
vi.mock('../../hooks/use-vault', () => ({
  useVault: () => ({ enabled: false }),
}));
vi.mock('../../db/vault', () => ({
  getVaultSecrets: () => undefined,
}));
vi.mock('../../sync/sync-engine', () => ({
  wipeAllData: h.wipeAllData,
  restoreFromBackup: vi.fn(),
  importData: vi.fn(),
}));
vi.mock('../../sync/remote-backups', () => ({
  listRemoteBackups: vi.fn(async () => []),
}));
vi.mock('../../db/export-import', () => ({
  parseImportZip: vi.fn(),
}));
vi.mock('../../components/settings/ExportDialog', () => ({
  ExportDialog: () => null,
}));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

describe('BackupsSettings — Wipe All Data prompt wall', () => {
  beforeEach(() => {
    h.wipeAllData.mockClear();
    h.local = { syncEnabled: false };
    render(
      <>
        <BackupsSettings />
        <ConfirmDialogContainer />
      </>,
    );
  });

  async function openWipeDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Wipe All Data' }));
    // Dialog open: its confirm button shares the label with the trigger.
    return screen.getAllByRole('button', { name: 'Wipe All Data' })[1];
  }

  it('does not wipe without the typed confirmation', async () => {
    const user = userEvent.setup();
    const confirmBtn = await openWipeDialog(user);

    expect(confirmBtn).toBeDisabled();
    await user.click(confirmBtn);
    expect(h.wipeAllData).not.toHaveBeenCalled();
  });

  it('wipes only after typing "yes" and confirming', async () => {
    const user = userEvent.setup();
    const confirmBtn = await openWipeDialog(user);

    await user.type(screen.getByPlaceholderText('Type "yes" to confirm'), 'yes');
    await user.click(confirmBtn);
    expect(h.wipeAllData).toHaveBeenCalledTimes(1);
  });

  it('does not wipe on Cancel', async () => {
    const user = userEvent.setup();
    await openWipeDialog(user);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.wipeAllData).not.toHaveBeenCalled();
  });
});
