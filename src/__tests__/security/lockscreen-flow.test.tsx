// @vitest-environment jsdom
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { lock, isUnlocked, __resetVaultStateForTests } from '../../db/vault';
import { useVault } from '../../hooks/use-vault';
import { SecuritySettings } from '../../components/settings/SecuritySettings';
import { LockScreen } from '../../components/security/LockScreen';
import type { Task } from '../../db/models';

const PASS = 'integration passphrase';

// Mirrors App.tsx: show the lock screen when locked, otherwise the app.
function Gate() {
  const { locked } = useVault();
  return locked ? <LockScreen /> : <div>APP CONTENT</div>;
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  const now = Date.now();
  await db.tasks.add({ id: 't1', listId: 'l1', title: 'visible task', status: 'todo', order: 1, createdAt: now, updatedAt: now } as Task);
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('Paranoid Mode UI flow', () => {
  it('enables via Security settings, locks, and unlocks via the lock screen', async () => {
    const user = userEvent.setup();
    render(<SecuritySettings />);

    // Enable form is shown when Paranoid Mode is off.
    await user.type(screen.getByLabelText('Passphrase'), PASS);
    await user.type(screen.getByLabelText('Confirm passphrase'), PASS);
    await user.click(screen.getByRole('button', { name: /enable paranoid mode/i }));

    // Switches to the active/manage view once enabled + migrated.
    await waitFor(() => expect(screen.getByText(/Active —/)).toBeInTheDocument(), { timeout: 15_000 });
    expect(isUnlocked()).toBe(true);

    // Task is encrypted at rest but readable while unlocked.
    expect((await db.tasks.get('t1'))?.title).toBe('visible task');

    // Now render the gate; unlocked -> app content visible.
    render(<Gate />);
    expect(screen.getByText('APP CONTENT')).toBeInTheDocument();

    // Lock -> the gate flips to the lock screen.
    act(() => { lock(); });
    await waitFor(() => expect(screen.getByText('Vault locked')).toBeInTheDocument());
    expect(screen.queryByText('APP CONTENT')).not.toBeInTheDocument();

    // Passphrase is entered by clicking the on-screen randomized keys, never typed.
    const tap = async (text: string) => {
      for (const ch of text) {
        await user.click(screen.getByRole('button', { name: ch === ' ' ? 'Space' : ch }));
      }
    };

    // Wrong passphrase shows an error and stays locked.
    await tap('wrong');
    await user.click(screen.getByRole('button', { name: /^unlock$/i }));
    await waitFor(() => expect(screen.getByText('Incorrect passphrase')).toBeInTheDocument());
    expect(isUnlocked()).toBe(false);

    // Correct passphrase unlocks and restores the app.
    await tap(PASS);
    await user.click(screen.getByRole('button', { name: /^unlock$/i }));
    await waitFor(() => expect(screen.getByText('APP CONTENT')).toBeInTheDocument());
    expect(isUnlocked()).toBe(true);
  });
});
