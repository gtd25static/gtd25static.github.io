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
  ensureEncryptionKey: vi.fn(async () => null),
  rotateSyncKey: vi.fn(),
  requirePassphrase: vi.fn(async (): Promise<string | null> => 'the passphrase'),
  confirm: vi.fn(async () => true),
  reach: { classicScopes: null as string[] | null, canPushAppSite: false },
}));

vi.mock('../../hooks/use-settings', () => ({
  useLocalSettings: () => h.local,
  updateLocalSettings: h.updateLocalSettings,
}));
vi.mock('../../hooks/use-vault', () => ({
  useVault: () => h.vault,
}));
vi.mock('../../sync/github-api', () => ({
  testConnection: vi.fn(),
  tokenReach: vi.fn(async () => h.reach),
  tokenReachWarning: (reach: { canPushAppSite: boolean }) => (reach.canPushAppSite ? 'TOKEN REACHES TOO FAR' : null),
}));
vi.mock('../../sync/sync-engine', () => ({
  syncNow: vi.fn(),
  ensureEncryptionKey: () => h.ensureEncryptionKey(),
  forcePush: vi.fn(),
  forcePull: vi.fn(),
  contentReplacedByLinking: h.contentReplacedByLinking,
}));
vi.mock('../../components/ui/ConfirmDialog', () => ({ confirmDialog: h.confirm }));
vi.mock('../../components/settings/passphrase-gate', () => ({
  requirePassphrase: h.requirePassphrase,
  // The proof-only gate (passphrase, or a security key): same answer as typing it here.
  requireOwner: async () => (await h.requirePassphrase()) !== null,
}));
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
vi.mock('../../sync/sync-lock', () => ({ withSyncLock: (fn: () => Promise<unknown>) => fn() }));

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

// Reliability review 2026-10-06: Save before the key was cached (the startup
// sync still deriving it, or the cache expired after 30 idle minutes) stored the
// new password as is — nothing re-encrypted, and this device locked out.
describe('GitHubSettings — changing the password before the key is cached', () => {
  beforeEach(() => {
    h.updateLocalSettings.mockClear();
    h.confirm.mockReset();
    h.confirm.mockResolvedValue(true);
    h.rotateSyncKey.mockReset();
    h.rotateSyncKey.mockResolvedValue({ blobsRewritten: 0, blobsUnreadable: 0, historySquashed: true });
    h.hasEncryptionKey.mockReturnValue(false);
    h.ensureEncryptionKey.mockReset();
    h.vault = { enabled: false, unlocked: false };
    h.secrets = undefined;
    h.local = { githubPat: 'ghp_token', githubRepo: 'owner/repo', encryptionPassword: 'alpha rhino cactus velvet moon', syncEnabled: true };
  });
  afterEach(() => h.hasEncryptionKey.mockReturnValue(false));

  it('gets the key first, then changes the password (not just stores it)', async () => {
    h.ensureEncryptionKey.mockImplementation(async () => { h.hasEncryptionKey.mockReturnValue(true); return {} as never; });
    const user = userEvent.setup();
    render(<GitHubSettings />);
    const field = screen.getByLabelText('Encryption Password');
    await user.clear(field);
    await user.type(field, 'harbor velvet 91 frosty lantern orbit');
    await user.type(screen.getByLabelText('Confirm Password'), 'harbor velvet 91 frosty lantern orbit');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(h.rotateSyncKey).toHaveBeenCalledWith('harbor velvet 91 frosty lantern orbit', expect.any(Function)));
    // The stored password stays the old one until the remote speaks the new.
    expect(h.updateLocalSettings).toHaveBeenCalledWith(expect.objectContaining({ encryptionPassword: 'alpha rhino cactus velvet moon' }));
  });
});

// Reliability review 2026-10-06 (B11): a new token was saved and nothing else
// happened — "Token rejected" stayed up until the next poll (minutes, in backoff).
describe('GitHubSettings — a new token on a device that syncs', () => {
  it('syncs at once', async () => {
    const { syncNow } = await import('../../sync/sync-engine');
    vi.mocked(syncNow).mockClear();
    h.hasEncryptionKey.mockReturnValue(true);
    h.vault = { enabled: false, unlocked: false };
    h.local = { githubPat: 'ghp_expired', githubRepo: 'owner/repo', encryptionPassword: 'alpha rhino cactus velvet moon', syncEnabled: true };
    const user = userEvent.setup();
    render(<GitHubSettings />);
    const field = screen.getByLabelText('Personal Access Token');
    await user.clear(field);
    await user.type(field, 'ghp_fresh');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(syncNow).toHaveBeenCalledWith(true));
    h.hasEncryptionKey.mockReturnValue(false);
  });
});

describe('GitHubSettings — Paranoid: where this device syncs is behind the passphrase', () => {
  // An unlocked but unattended session could point the device at another
  // repository — every later change would be streamed there (GUI review).
  beforeEach(() => {
    h.updateLocalSettings.mockClear();
    h.setVaultSecrets.mockClear();
    h.requirePassphrase.mockReset();
    h.vault = { enabled: true, unlocked: true };
    h.secrets = { githubPat: 'ghp_old', syncPassword: 'alpha rhino cactus velvet moon' };
    h.local = { githubRepo: 'owner/repo', syncEnabled: true };
  });

  async function repoChangedTo(user: ReturnType<typeof userEvent.setup>, repo: string) {
    const field = screen.getByLabelText('Repository (owner/name)');
    await user.clear(field);
    await user.type(field, repo);
    await user.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('asks, and saves nothing without it', async () => {
    h.requirePassphrase.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<GitHubSettings />);
    await repoChangedTo(user, 'someone-else/repo');
    expect(h.requirePassphrase).toHaveBeenCalledOnce();
    expect(h.setVaultSecrets).not.toHaveBeenCalled();
    expect(h.updateLocalSettings).not.toHaveBeenCalled();
  });

  it('saves once the passphrase is confirmed', async () => {
    h.requirePassphrase.mockResolvedValue('the passphrase');
    const user = userEvent.setup();
    render(<GitHubSettings />);
    await repoChangedTo(user, 'owner/new-repo');
    expect(h.updateLocalSettings).toHaveBeenCalledWith(expect.objectContaining({ githubRepo: 'owner/new-repo' }));
  });

  it('does not ask when nothing about the sync target changed', async () => {
    const user = userEvent.setup();
    render(<GitHubSettings />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(h.requirePassphrase).not.toHaveBeenCalled();
  });
});

describe('GitHubSettings — Paranoid: the saved credentials never reach the form', () => {
  // The passphrase gate guarded CHANGING where this device syncs, but the form
  // was prefilled with the PAT and sync password (each with a reveal toggle), so
  // an unattended unlocked session could simply read them — the same lasting
  // access to every later change, without changing anything (threat-model review).
  beforeEach(() => {
    h.updateLocalSettings.mockClear();
    h.setVaultSecrets.mockClear();
    h.requirePassphrase.mockReset();
    h.requirePassphrase.mockResolvedValue('the passphrase');
    h.isRemoteUnlockEnrolled.mockResolvedValue(false);
    h.vault = { enabled: true, unlocked: true };
    h.secrets = { githubPat: 'ghp_SECRET_TOKEN', syncPassword: 'SECRET sync words here' };
    h.local = { githubRepo: 'owner/repo', syncEnabled: true };
  });

  it('shows neither secret, only that one is saved', () => {
    const { container } = render(<GitHubSettings />);
    expect(screen.getByLabelText('Personal Access Token')).toHaveValue('');
    expect(screen.getByLabelText('Encryption Password')).toHaveValue('');
    expect(screen.getByLabelText('Personal Access Token')).toHaveAttribute('placeholder', expect.stringMatching(/saved/i));
    expect(screen.getByLabelText('Encryption Password')).toHaveAttribute('placeholder', expect.stringMatching(/saved/i));
    expect(container.innerHTML).not.toContain('SECRET');
  });

  it('saving with the fields left empty keeps both secrets, and asks for nothing', async () => {
    const user = userEvent.setup();
    render(<GitHubSettings />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(h.requirePassphrase).not.toHaveBeenCalled();
    expect(h.setVaultSecrets).toHaveBeenCalledWith({ githubPat: 'ghp_SECRET_TOKEN', syncPassword: 'SECRET sync words here' });
    expect(h.updateLocalSettings).toHaveBeenCalledWith(expect.objectContaining({ syncEnabled: true }));
  });

  it('a new PAT typed in replaces the saved one, behind the passphrase', async () => {
    const user = userEvent.setup();
    render(<GitHubSettings />);
    await user.type(screen.getByLabelText('Personal Access Token'), 'github_pat_NEW');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(h.requirePassphrase).toHaveBeenCalledOnce();
    expect(h.setVaultSecrets).toHaveBeenCalledWith(expect.objectContaining({ githubPat: 'github_pat_NEW', syncPassword: 'SECRET sync words here' }));
    // …and does not stay on screen afterwards.
    expect(screen.getByLabelText('Personal Access Token')).toHaveValue('');
  });
});

describe('GitHubSettings — a token that reaches beyond the sync repository', () => {
  // A classic token, or any token that can push to the repository serving this
  // app: a leak of it (TLS proxy, keylogger, disk image) would let someone change
  // the app on every device (threat-model review, batch 2).
  beforeEach(() => {
    h.toast.mockClear();
    h.updateLocalSettings.mockClear();
    h.vault = { enabled: false, unlocked: false };
    h.secrets = undefined;
    h.local = { githubPat: '', githubRepo: 'owner/repo', syncEnabled: false };
    h.contentReplacedByLinking.mockResolvedValue(null);
  });

  it('is called out when the device is linked with it', async () => {
    h.reach = { classicScopes: ['repo'], canPushAppSite: true };
    const user = userEvent.setup();
    render(<GitHubSettings />);
    await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_classic');
    await user.type(screen.getByLabelText('Encryption Password'), 'alpha rhino cactus velvet moon');
    await user.type(screen.getByLabelText('Confirm Password'), 'alpha rhino cactus velvet moon');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(h.toast).toHaveBeenCalledWith('TOKEN REACHES TOO FAR', 'error'));
  });

  it('says nothing for a token limited to the sync repository', async () => {
    h.reach = { classicScopes: null, canPushAppSite: false };
    const user = userEvent.setup();
    render(<GitHubSettings />);
    await user.type(screen.getByLabelText('Personal Access Token'), 'github_pat_scoped');
    await user.type(screen.getByLabelText('Encryption Password'), 'alpha rhino cactus velvet moon');
    await user.type(screen.getByLabelText('Confirm Password'), 'alpha rhino cactus velvet moon');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.toast).not.toHaveBeenCalledWith('TOKEN REACHES TOO FAR', 'error');
  });
});
