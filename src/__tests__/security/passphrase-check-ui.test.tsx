// @vitest-environment jsdom
import { vi } from 'vitest';
// Real Argon2id derivations per test (light params from setup.ts, but the full
// suite saturates the CPU) — keep generous headroom.
vi.setConfig({ testTimeout: 45_000 });
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import * as vaultKdf from '../../db/vault-kdf';
import type { KdfParams } from '../../db/vault-kdf';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, setSecondaryPassphrase, lock, isUnlocked, __resetVaultStateForTests } from '../../db/vault';
import { SecuritySettings } from '../../components/settings/SecuritySettings';
import { ToastContainer } from '../../components/ui/Toast';
import type { Task } from '../../db/models';

// The Settings "Check" control on top of the real vault: it reports which
// passphrase was typed and changes nothing — the vault stays unlocked on the
// real content, and the typed passphrase doesn't linger in the field.

const REAL = 'integration flow lock screen passphrase';
const SECONDARY = 'a different strong secondary passphrase';

async function renderSettings() {
  const user = userEvent.setup();
  render(<><ToastContainer /><SecuritySettings /></>);
  await screen.findByLabelText('Passphrase to check');
  return user;
}

async function checkTyped(user: ReturnType<typeof userEvent.setup>, candidate: string) {
  await user.type(screen.getByLabelText('Passphrase to check'), candidate);
  await user.click(screen.getByRole('button', { name: 'Check' }));
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.clear();
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'REAL_MARKER task', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);
  await enableParanoid(REAL);
  await setSecondaryPassphrase(SECONDARY);
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetVaultStateForTests();
  localStorage.clear();
});

describe('Check a passphrase (Settings)', () => {
  it('confirms the secondary passphrase and changes nothing', async () => {
    const user = await renderSettings();
    const vaultBefore = await db.vault.get('vault');

    await checkTyped(user, SECONDARY);

    expect(await screen.findByText(/This is the secondary passphrase/)).toBeInTheDocument();
    expect(isUnlocked()).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe('REAL_MARKER task');
    expect(await db.vault.get('vault')).toEqual(vaultBefore);
  });

  it('recognises the main passphrase', async () => {
    const user = await renderSettings();
    await checkTyped(user, REAL);
    expect(await screen.findByText('This is your main passphrase.')).toBeInTheDocument();
  });

  it('says a wrong passphrase opens nothing', async () => {
    const user = await renderSettings();
    await checkTyped(user, 'nothing like either of them');
    expect(await screen.findByText("This passphrase doesn't open this vault.")).toBeInTheDocument();
  });

  it('clears the typed passphrase after checking', async () => {
    const user = await renderSettings();
    await checkTyped(user, SECONDARY);
    await screen.findByText(/This is the secondary passphrase/);
    expect(screen.getByLabelText('Passphrase to check')).toHaveValue('');
  });

  it('is disabled until something is typed, and keeps password managers out', async () => {
    await renderSettings();
    expect(screen.getByRole('button', { name: 'Check' })).toBeDisabled();
    expect(screen.getByLabelText('Passphrase to check')).toHaveAttribute('autocomplete', 'off');
  });

  it('checks on Enter too', async () => {
    const user = await renderSettings();
    await user.type(screen.getByLabelText('Passphrase to check'), `${REAL}{Enter}`);
    expect(await screen.findByText('This is your main passphrase.')).toBeInTheDocument();
  });

  it('shows no answer when the vault locked during the check', async () => {
    const user = await renderSettings();
    const realDerive = vaultKdf.deriveVaultKek;
    vi.spyOn(vaultKdf, 'deriveVaultKek').mockImplementation(async (pass: string, salt: string, kdf: KdfParams) => {
      const kek = await realDerive(pass, salt, kdf);
      lock();
      return kek;
    });

    await checkTyped(user, SECONDARY);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Check' })).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    for (const answer of [/This is the secondary passphrase/, 'This is your main passphrase.', "This passphrase doesn't open this vault.", /Unlock the vault first/]) {
      expect(screen.queryByText(answer)).not.toBeInTheDocument();
    }
  });
});
