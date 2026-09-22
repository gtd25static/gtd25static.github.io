// @vitest-environment jsdom
import { vi } from 'vitest';
// Real Argon2id derivations per test (light params from setup.ts, but the full
// suite saturates the CPU) — keep generous headroom.
vi.setConfig({ testTimeout: 60_000 });
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { installWebAuthnMock, uninstallWebAuthnMock } from '../helpers/webauthn-mock';
import { wrapDek, generateDek, importKekFromBytes, isLegacyWrap } from '../../db/vault-crypto';
import {
  enableParanoid, setSecondaryPassphrase, addSecurityKey, listSecurityKeys, isUnlocked, checkPassphrase,
  __resetVaultStateForTests,
} from '../../db/vault';
import { SecuritySettings } from '../../components/settings/SecuritySettings';
import { ToastContainer } from '../../components/ui/Toast';
import { ConfirmDialogContainer } from '../../components/ui/ConfirmDialog';
import { PasswordPromptContainer } from '../../components/ui/PasswordPrompt';
import type { Task } from '../../db/models';

// The passphrase gate in Settings on top of the real vault: anything that changes
// how the vault opens asks for the main passphrase, refuses the secondary one,
// and does nothing on a wrong answer or a cancel.

const REAL = 'integration flow lock screen passphrase';
const SECONDARY = 'a different strong secondary passphrase';
const WRONG = 'nothing like either of them';

async function renderSettings() {
  const user = userEvent.setup();
  render(<><ConfirmDialogContainer /><PasswordPromptContainer /><ToastContainer /><SecuritySettings /></>);
  await screen.findByRole('heading', { name: 'Security keys' });
  return user;
}

function section(name: string) {
  return within(screen.getByRole('heading', { name }).parentElement!);
}

async function answerPrompt(user: ReturnType<typeof userEvent.setup>, passphrase: string | null) {
  const field = await screen.findByPlaceholderText('Vault passphrase');
  if (passphrase === null) {
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    return;
  }
  await user.type(field, passphrase);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.clear();
  installWebAuthnMock();
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'REAL_MARKER task', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Task);
  await enableParanoid(REAL);
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallWebAuthnMock();
  __resetVaultStateForTests();
  localStorage.clear();
});

describe('removing a security key', () => {
  beforeEach(async () => {
    await addSecurityKey('YubiKey');
  });

  /** The key's Remove button (the list loads asynchronously), then the confirm dialog's. */
  async function clickRemove(user: ReturnType<typeof userEvent.setup>) {
    const inList = await section('Security keys').findByRole('button', { name: 'Remove' });
    await user.click(inList);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBeGreaterThan(1));
    await user.click(screen.getAllByRole('button', { name: 'Remove' }).find((b) => b !== inList)!);
  }

  it('asks for the passphrase; a wrong one removes nothing', async () => {
    const user = await renderSettings();
    await clickRemove(user);
    await answerPrompt(user, WRONG);
    expect(await screen.findByText('Incorrect passphrase')).toBeInTheDocument();
    expect(await listSecurityKeys()).toHaveLength(1);
    expect(screen.getByText('YubiKey')).toBeInTheDocument();
  });

  it('refuses the secondary passphrase like any wrong one', async () => {
    await setSecondaryPassphrase(SECONDARY);
    const user = await renderSettings();
    await clickRemove(user);
    await answerPrompt(user, SECONDARY);
    expect(await screen.findByText('Incorrect passphrase')).toBeInTheDocument();
    expect(await listSecurityKeys()).toHaveLength(1);
    expect(isUnlocked()).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe('REAL_MARKER task');
  });

  it('cancelling the prompt removes nothing and says nothing', async () => {
    const user = await renderSettings();
    await clickRemove(user);
    await answerPrompt(user, null);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Incorrect passphrase')).toBeNull();
    expect(await listSecurityKeys()).toHaveLength(1);
  });

  it('with the passphrase: removes the key and offers the re-key, which uses the same passphrase', async () => {
    const user = await renderSettings();
    const vaultBefore = (await db.vault.get('vault'))!;
    await clickRemove(user);
    await answerPrompt(user, REAL);
    expect(await screen.findByText('Security key removed')).toBeInTheDocument();
    expect(await listSecurityKeys()).toHaveLength(0);

    expect(await screen.findByText(/could still open a copy of this device/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Re-key now' }));
    expect(await screen.findByText(/Device re-keyed/)).toBeInTheDocument();
    const vaultAfter = (await db.vault.get('vault'))!;
    expect(vaultAfter.dekWrappedByPass).not.toBe(vaultBefore.dekWrappedByPass);
    expect(vaultAfter.verifier).not.toBe(vaultBefore.verifier);
    expect(isUnlocked()).toBe(true);
    expect((await db.tasks.get('t1'))?.title).toBe('REAL_MARKER task');
  });
});

describe('Re-key this device', () => {
  it('needs the current passphrase in its own field', async () => {
    const user = await renderSettings();
    const vaultBefore = (await db.vault.get('vault'))!;
    const block = section('Re-key this device');
    await user.type(block.getByLabelText('Current passphrase'), WRONG);
    await user.click(block.getByRole('button', { name: 'Re-key device' }));
    expect(await screen.findByText('Incorrect passphrase')).toBeInTheDocument();
    expect(await db.vault.get('vault')).toEqual(vaultBefore);
  });

  it('re-keys with the passphrase and says what has to be set up again', async () => {
    await setSecondaryPassphrase(SECONDARY);
    const user = await renderSettings();
    const vaultBefore = (await db.vault.get('vault'))!;
    const block = section('Re-key this device');
    await user.type(block.getByLabelText('Current passphrase'), REAL);
    await user.click(block.getByRole('button', { name: 'Re-key device' }));
    expect(await screen.findByText(/Device re-keyed\. Set the secondary passphrase again if you use one\./)).toBeInTheDocument();
    const vaultAfter = (await db.vault.get('vault'))!;
    expect(vaultAfter.dekWrappedByPass).not.toBe(vaultBefore.dekWrappedByPass);
    expect(await checkPassphrase(SECONDARY)).toBe('none');
    expect((await db.tasks.get('t1'))?.title).toBe('REAL_MARKER task');
    expect((block.getByLabelText('Current passphrase') as HTMLInputElement).value).toBe('');
  });
});

describe('the secondary passphrase controls', () => {
  it('setting one asks for the main passphrase first', async () => {
    const user = await renderSettings();
    const block = section('Secondary passphrase');
    await user.type(block.getByLabelText('Secondary passphrase'), SECONDARY);
    await user.type(block.getByLabelText('Confirm'), SECONDARY);
    await user.click(block.getByRole('button', { name: 'Save' }));
    await answerPrompt(user, WRONG);
    expect(await screen.findByText('Incorrect passphrase')).toBeInTheDocument();
    expect(await checkPassphrase(SECONDARY)).toBe('none');

    await user.click(block.getByRole('button', { name: 'Save' }));
    await answerPrompt(user, REAL);
    expect(await screen.findByText('Secondary passphrase saved')).toBeInTheDocument();
    expect(await checkPassphrase(SECONDARY)).toBe('secondary');
  });

  it('points out a slot 2 from before slot binding, until the secondary passphrase is set again', async () => {
    // A slot 2 as an older build wrote it (garbage or real: the notice cannot tell, by design).
    const legacyGarbage = await wrapDek(await importKekFromBytes(crypto.getRandomValues(new Uint8Array(32))), await generateDek());
    await db.vault.update('vault', { wrappedDek2: legacyGarbage });
    expect(isLegacyWrap(legacyGarbage)).toBe(true);
    const user = await renderSettings();
    const notice = /set it again to finish a security update/;
    expect(await screen.findByText(notice)).toBeInTheDocument();

    const block = section('Secondary passphrase');
    await user.type(block.getByLabelText('Secondary passphrase'), SECONDARY);
    await user.type(block.getByLabelText('Confirm'), SECONDARY);
    await user.click(block.getByRole('button', { name: 'Save' }));
    await answerPrompt(user, REAL);
    await screen.findByText('Secondary passphrase saved');
    await waitFor(() => expect(screen.queryByText(notice)).toBeNull());
  });

  it('shows no such notice on a vault written with bound wraps', async () => {
    await renderSettings();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/finish a security update/)).toBeNull();
  });
});
