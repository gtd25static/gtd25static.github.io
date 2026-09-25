// @vitest-environment jsdom
//
// Guards the ACR-014 gate on the GitHub Sync settings form: setting/changing the
// sync password here must enforce the same strength check as the encryption
// password modal (this entry point used to bypass it entirely). Uses the REAL
// password-strength estimator — these tests also pin the recalibrated threshold.
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { GitHubSettings } from '../../components/settings/GitHubSettings';

const h = vi.hoisted(() => ({
  updateLocalSettings: vi.fn(),
  toast: vi.fn(),
  local: {} as Record<string, unknown>,
  vault: { enabled: false, unlocked: false },
  secrets: undefined as { githubPat?: string; syncPassword?: string } | undefined,
  setVaultSecrets: vi.fn(async () => undefined),
  isRemoteUnlockEnrolled: vi.fn(async () => false),
  contentReplacedByLinking: vi.fn(async () => null as null | { lists: number; tasks: number; maps: number }),
  hasEncryptionKey: vi.fn(() => false),
  rotateSyncKey: vi.fn(),
  confirm: vi.fn(async () => true),
}));

vi.mock('../../hooks/use-settings', () => ({
  useLocalSettings: () => h.local,
  updateLocalSettings: h.updateLocalSettings,
}));
vi.mock('../../hooks/use-vault', () => ({
  useVault: () => h.vault,
}));
vi.mock('../../sync/github-api', () => ({ testConnection: vi.fn() }));
vi.mock('../../sync/sync-engine', () => ({
  syncNow: vi.fn(),
  forcePush: vi.fn(),
  forcePull: vi.fn(),
  contentReplacedByLinking: h.contentReplacedByLinking,
}));
vi.mock('../../components/ui/ConfirmDialog', () => ({ confirmDialog: h.confirm }));
vi.mock('../../sync/crypto', () => ({
  deriveKey: vi.fn(async () => ({})),
  cacheEncryptionKey: vi.fn(),
  generateSalt: vi.fn(() => 'salt'),
  hasEncryptionKey: () => h.hasEncryptionKey(),
}));
vi.mock('../../db/vault', async () => ({
  getVaultSecrets: () => h.secrets,
  setVaultSecrets: h.setVaultSecrets,
  isRemoteUnlockEnrolled: h.isRemoteUnlockEnrolled,
  touchVaultActivity: vi.fn(),
}));
vi.mock('../../sync/key-rotation', () => ({
  rotateSyncKey: (...args: unknown[]) => (h.rotateSyncKey as (...a: unknown[]) => unknown)(...args),
  hasUnfinishedRotation: vi.fn(async () => false),
  discardUnfinishedRotation: vi.fn(),
}));
vi.mock('../../components/ui/Toast', () => ({ toast: h.toast }));

describe('GitHubSettings — sync password strength gate (ACR-014)', () => {
  beforeEach(() => {
    h.updateLocalSettings.mockClear();
    h.toast.mockClear();
    h.vault = { enabled: false, unlocked: false };
    h.secrets = undefined;
    h.local = {
      githubPat: 'ghp_token',
      githubRepo: 'owner/repo',
      encryptionPassword: 'alpha rhino cactus velvet moon',
      syncEnabled: true,
    };
  });

  async function typeNewPassword(user: ReturnType<typeof userEvent.setup>, password: string) {
    const field = screen.getByLabelText('Encryption Password');
    await user.clear(field);
    await user.type(field, password);
    await user.type(screen.getByLabelText('Confirm Password'), password);
  }

  it('rejects a weak new sync password and saves nothing', async () => {
    const user = userEvent.setup();
    render(<GitHubSettings />);

    await typeNewPassword(user, 'sunshine dolphin'); // 2 words ≈ 26 bits
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/One or two words/), 'error');
    expect(h.updateLocalSettings).not.toHaveBeenCalled();
  });

  it('accepts a 4-word passphrase (recalibrated threshold) and saves', async () => {
    const user = userEvent.setup();
    render(<GitHubSettings />);

    await typeNewPassword(user, 'alpha rhino cactus velvet');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(h.updateLocalSettings).toHaveBeenCalledWith(
      expect.objectContaining({ encryptionPassword: 'alpha rhino cactus velvet' }),
    );
    expect(h.toast).toHaveBeenCalledWith('Sync settings saved', 'success');
  });

  it('shows the live strength bar while the password differs from the current one', async () => {
    const user = userEvent.setup();
    render(<GitHubSettings />);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    const field = screen.getByLabelText('Encryption Password');
    await user.clear(field);
    await user.type(field, 'something new');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});

// Remote unlock/wipe deliberately keeps the PAT in plaintext localSettings: it is
// the only backend access a LOCKED device has. Saving sync settings used to clear
// that field unconditionally on a Paranoid device, which silently stopped the
// remote-wipe watcher and removed "request unlock" from the lock screen — while
// Settings kept reporting "Enabled", because enrolment lives in the vault row.
describe('GitHubSettings — Paranoid keeps the remote-unlock mailbox PAT', () => {
  beforeEach(() => {
    h.updateLocalSettings.mockClear();
    h.toast.mockClear();
    h.setVaultSecrets.mockClear();
    h.isRemoteUnlockEnrolled.mockClear();
    h.vault = { enabled: true, unlocked: true };
    h.secrets = { githubPat: 'ghp_token', syncPassword: 'alpha rhino cactus velvet' };
    h.local = { githubRepo: 'owner/repo', syncEnabled: true };
  });

  async function save(user: ReturnType<typeof userEvent.setup>) {
    render(<GitHubSettings />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('keeps the plaintext PAT when remote unlock is enrolled', async () => {
    h.isRemoteUnlockEnrolled.mockResolvedValue(true);
    await save(userEvent.setup());

    expect(h.updateLocalSettings).toHaveBeenCalledWith(
      expect.objectContaining({ githubPat: 'ghp_token' }),
    );
    // The secret still goes into the vault as well — this is a copy, not a move.
    expect(h.setVaultSecrets).toHaveBeenCalledWith(
      expect.objectContaining({ githubPat: 'ghp_token' }),
    );
  });

  it('clears it when remote unlock is NOT enrolled', async () => {
    h.isRemoteUnlockEnrolled.mockResolvedValue(false);
    await save(userEvent.setup());

    expect(h.updateLocalSettings).toHaveBeenCalledWith(
      expect.objectContaining({ githubPat: undefined, encryptionPassword: undefined }),
    );
  });
});

describe('GitHubSettings — linking a device that already has data', () => {
  // Linking replaces this device's content with the repository's (it can't be a
  // merge — see contentReplacedByLinking); that used to happen without a word.
  beforeEach(() => {
    h.updateLocalSettings.mockClear();
    h.confirm.mockClear();
    h.contentReplacedByLinking.mockReset();
    h.vault = { enabled: false, unlocked: false };
    h.secrets = undefined;
    h.local = { syncEnabled: false };
  });

  async function link(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_token');
    await user.type(screen.getByLabelText('Repository (owner/name)'), 'owner/repo');
    await user.type(screen.getByLabelText('Encryption Password'), 'alpha rhino cactus velvet moon');
    await user.type(screen.getByLabelText('Confirm Password'), 'alpha rhino cactus velvet moon');
    await user.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('asks first, and saves nothing when the user backs out', async () => {
    h.contentReplacedByLinking.mockResolvedValue({ lists: 2, tasks: 5, maps: 0 });
    h.confirm.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<GitHubSettings />);
    await link(user);

    expect(h.contentReplacedByLinking).toHaveBeenCalledWith('ghp_token', 'owner/repo');
    expect(h.confirm).toHaveBeenCalledWith(expect.stringContaining('2 lists, 5 tasks'), expect.objectContaining({ danger: true }));
    expect(h.updateLocalSettings).not.toHaveBeenCalled();
  });

  it('links once the user confirms', async () => {
    h.contentReplacedByLinking.mockResolvedValue({ lists: 1, tasks: 1, maps: 1 });
    h.confirm.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<GitHubSettings />);
    await link(user);

    expect(h.confirm).toHaveBeenCalledWith(expect.stringContaining('1 list, 1 task, 1 mindmap'), expect.anything());
    expect(h.updateLocalSettings).toHaveBeenCalledWith(expect.objectContaining({ syncEnabled: true }));
  });

  it('does not ask when nothing on this device would be replaced', async () => {
    h.contentReplacedByLinking.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<GitHubSettings />);
    await link(user);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.updateLocalSettings).toHaveBeenCalledWith(expect.objectContaining({ syncEnabled: true }));
  });
});

describe('GitHubSettings — changing the sync password', () => {
  beforeEach(() => {
    h.updateLocalSettings.mockClear();
    h.confirm.mockReset();
    h.confirm.mockResolvedValue(true);
    h.hasEncryptionKey.mockReturnValue(true);
    h.vault = { enabled: false, unlocked: false };
    h.secrets = undefined;
    h.local = {
      githubPat: 'ghp_token',
      githubRepo: 'owner/repo',
      encryptionPassword: 'alpha rhino cactus velvet moon',
      syncEnabled: true,
    };
  });
  afterEach(() => h.hasEncryptionKey.mockReturnValue(false));

  it('covers the screen with the progress dialog for the whole rotation, then removes it', async () => {
    let report!: (p: { phase: string; done?: number; total?: number }) => void;
    let finish!: () => void;
    h.rotateSyncKey.mockImplementation((_pw: string, onProgress: typeof report) => {
      report = onProgress;
      return new Promise((resolve) => { finish = () => resolve({ blobsRewritten: 0, blobsUnreadable: 0, historySquashed: true }); });
    });
    const user = userEvent.setup();
    render(<GitHubSettings />);
    const field = screen.getByLabelText('Encryption Password');
    await user.clear(field);
    await user.type(field, 'harbor velvet 91 frosty lantern orbit');
    await user.type(screen.getByLabelText('Confirm Password'), 'harbor velvet 91 frosty lantern orbit');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog', { name: 'Changing the sync password' });
    expect(dialog).toHaveAttribute('open');
    await act(async () => report({ phase: 'files', done: 0, total: 2 }));
    expect(screen.getByText(/Re-encrypting shared files 1\/2/)).toBeInTheDocument();

    await act(async () => finish());
    expect(screen.queryByRole('dialog', { name: 'Changing the sync password' })).not.toBeInTheDocument();
    expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/Sync password changed/), 'success');
  });
});
