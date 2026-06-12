// @vitest-environment jsdom
//
// Guards the ACR-014 gate on the GitHub Sync settings form: setting/changing the
// sync password here must enforce the same strength check as the encryption
// password modal (this entry point used to bypass it entirely). Uses the REAL
// password-strength estimator — these tests also pin the recalibrated threshold.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { GitHubSettings } from '../../components/settings/GitHubSettings';

const h = vi.hoisted(() => ({
  updateLocalSettings: vi.fn(),
  toast: vi.fn(),
  local: {} as Record<string, unknown>,
}));

vi.mock('../../hooks/use-settings', () => ({
  useLocalSettings: () => h.local,
  updateLocalSettings: h.updateLocalSettings,
}));
vi.mock('../../hooks/use-vault', () => ({
  useVault: () => ({ enabled: false, unlocked: false }),
}));
vi.mock('../../db/vault', () => ({
  getVaultSecrets: () => undefined,
  setVaultSecrets: vi.fn(),
}));
vi.mock('../../sync/github-api', () => ({ testConnection: vi.fn() }));
vi.mock('../../sync/sync-engine', () => ({
  syncNow: vi.fn(),
  forcePush: vi.fn(),
  forcePull: vi.fn(),
}));
vi.mock('../../sync/crypto', () => ({
  deriveKey: vi.fn(async () => ({})),
  cacheEncryptionKey: vi.fn(),
  generateSalt: vi.fn(() => 'salt'),
}));
vi.mock('../../components/ui/Toast', () => ({ toast: h.toast }));

describe('GitHubSettings — sync password strength gate (ACR-014)', () => {
  beforeEach(() => {
    h.updateLocalSettings.mockClear();
    h.toast.mockClear();
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
