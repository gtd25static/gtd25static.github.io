// @vitest-environment jsdom
//
// "Download" on a safety backup goes through the real export dialog, so it gets
// the same encryption choice as an export — encrypted by default on a Paranoid
// device. It used to write a plaintext zip to Downloads even from one.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { BackupsSettings } from '../../components/settings/BackupsSettings';

const BACKUP = { key: 'gtd25-local-backup-1700000000000', timestamp: 1_700_000_000_000 };
const BACKUP_DATA = {
  taskLists: [], tasks: [{ id: 't1', title: 'x' }], subtasks: [],
  mindmapFolders: [], mindmaps: [], mindmapNodes: [],
};

const h = vi.hoisted(() => ({
  paranoid: true,
  zipImportData: vi.fn(async () => new Blob(['zip'])),
  exportToZip: vi.fn(async () => new Blob(['live'])),
  downloads: [] as string[],
}));

vi.mock('../../hooks/use-settings', () => ({ useLocalSettings: () => ({ syncEnabled: false }) }));
vi.mock('../../hooks/use-vault', () => ({ useVault: () => ({ enabled: h.paranoid }) }));
vi.mock('../../db/vault', () => ({ getVaultSecrets: () => ({ syncPassword: 'the-sync-password' }) }));
vi.mock('../../sync/sync-engine', () => ({ wipeAllData: vi.fn(), restoreFromBackup: vi.fn(), importData: vi.fn() }));
vi.mock('../../db/backup', () => ({
  getLocalBackups: () => [BACKUP],
  readLocalBackup: vi.fn(async () => BACKUP_DATA),
}));
vi.mock('../../sync/remote-backups', () => ({ listRemoteBackups: vi.fn(async () => []) }));
vi.mock('../../db/export-import', () => ({
  parseImportZip: vi.fn(),
  zipImportData: h.zipImportData,
  exportToZip: h.exportToZip,
}));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

beforeEach(() => {
  h.paranoid = true;
  h.zipImportData.mockClear();
  h.exportToZip.mockClear();
  h.downloads = [];
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    h.downloads.push(this.download);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openDownload() {
  const user = userEvent.setup();
  render(<BackupsSettings />);
  await user.click(screen.getByRole('button', { name: 'Download' }));
  const dialog = screen.getByRole('heading', { name: 'Download safety backup' }).closest('dialog') as HTMLElement;
  return { user, dialog: within(dialog) };
}

describe('Download a safety backup', () => {
  it('asks first, with encryption preselected on a Paranoid device', async () => {
    const { dialog } = await openDownload();
    expect(dialog.getByRole('radio', { name: /Encrypted with a passphrase/ })).toBeChecked();
    expect(h.zipImportData).not.toHaveBeenCalled();
    expect(h.downloads).toEqual([]);
  });

  it('encrypts the backup with the chosen passphrase', async () => {
    const { user, dialog } = await openDownload();
    await user.type(dialog.getByLabelText('Passphrase'), 'correct horse battery');
    await user.type(dialog.getByLabelText('Confirm passphrase'), 'correct horse battery');
    await user.click(dialog.getByRole('button', { name: 'Export' }));

    expect(h.zipImportData).toHaveBeenCalledTimes(1);
    const [data, exportedAt, opts] = h.zipImportData.mock.calls[0] as unknown as [Record<string, unknown>, number, unknown];
    expect(opts).toEqual({ encrypt: { password: 'correct horse battery', keySource: 'passphrase' } });
    expect(exportedAt).toBe(BACKUP.timestamp);
    // Mindmaps stay out of the portable zip, as before.
    expect(Object.keys(data).sort()).toEqual(['subtasks', 'taskLists', 'tasks']);
    expect(h.downloads).toEqual([expect.stringMatching(/^gtd25-safety-backup-.*\.zip$/)]);
    expect(h.exportToZip).not.toHaveBeenCalled(); // the backup, not the live data
  });

  it('can encrypt with the sync password instead', async () => {
    const { user, dialog } = await openDownload();
    await user.click(dialog.getByRole('radio', { name: /Encrypted with your sync password/ }));
    await user.click(dialog.getByRole('button', { name: 'Export' }));
    const opts = (h.zipImportData.mock.calls[0] as unknown[])[2];
    expect(opts).toEqual({ encrypt: { password: 'the-sync-password', keySource: 'sync' } });
  });

  it('writes plaintext only when that is explicitly chosen', async () => {
    const { user, dialog } = await openDownload();
    await user.click(dialog.getByRole('radio', { name: /Unencrypted/ }));
    await user.click(dialog.getByRole('button', { name: 'Export' }));
    expect((h.zipImportData.mock.calls[0] as unknown[])[2]).toBeUndefined();
  });

  it('downloads nothing on Cancel', async () => {
    const { user, dialog } = await openDownload();
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(h.zipImportData).not.toHaveBeenCalled();
    expect(h.downloads).toEqual([]);
  });

  it('defaults to unencrypted off Paranoid Mode, like Export', async () => {
    h.paranoid = false;
    const { dialog } = await openDownload();
    expect(dialog.getByRole('radio', { name: /Unencrypted/ })).toBeChecked();
  });
});
