// @vitest-environment jsdom
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../__tests__/setup-component';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, lock, isUnlocked, __resetVaultStateForTests } from '../../db/vault';
import { useVault } from '../../hooks/use-vault';
import { SecuritySettings } from '../../components/settings/SecuritySettings';
import { LockScreen } from '../../components/security/LockScreen';
import type { Task } from '../../db/models';
import { usePomodoroStore } from '../../stores/pomodoro-store';

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
  usePomodoroStore.setState({
    timerRunning: false,
    timerEndTime: null,
    displaySeconds: 0,
    ambientPlaying: false,
    pomodoroSettingsOpen: false,
  });
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

    // Default entry is a normal typed passphrase field.
    // Wrong passphrase shows an error and stays locked.
    await user.type(screen.getByLabelText('Passphrase'), 'wrong');
    await user.click(screen.getByRole('button', { name: /^unlock$/i }));
    await waitFor(() => expect(screen.getByText('Incorrect passphrase')).toBeInTheDocument());
    expect(isUnlocked()).toBe(false);

    // Correct passphrase unlocks and restores the app (field was cleared on failure).
    await user.type(screen.getByLabelText('Passphrase'), PASS);
    await user.click(screen.getByRole('button', { name: /^unlock$/i }));
    await waitFor(() => expect(screen.getByText('APP CONTENT')).toBeInTheDocument());
    expect(isUnlocked()).toBe(true);
  });

  it('can unlock via the opt-in on-screen randomized keyboard', async () => {
    const user = userEvent.setup();
    await enableParanoid(PASS);
    lock();

    render(<Gate />);
    await waitFor(() => expect(screen.getByText('Vault locked')).toBeInTheDocument());

    // Switch to the keylogger-safe on-screen keyboard, then tap the passphrase.
    await user.click(screen.getByRole('button', { name: /on-screen keyboard/i }));
    for (const ch of PASS) {
      await user.click(screen.getByRole('button', { name: ch === ' ' ? 'Space' : ch }));
    }
    await user.click(screen.getByRole('button', { name: /^unlock$/i }));

    await waitFor(() => expect(screen.getByText('APP CONTENT')).toBeInTheDocument());
    expect(isUnlocked()).toBe(true);
  });

  it('shows and persists the configured idle timeout minutes', async () => {
    const user = userEvent.setup();
    await enableParanoid(PASS, 42);

    const { unmount } = render(<SecuritySettings />);
    const idleInput = await screen.findByLabelText('Auto-lock after (minutes idle)');

    await waitFor(() => expect(idleInput).toHaveValue(42));

    await user.clear(idleInput);
    await user.type(idleInput, '7');
    await user.click(screen.getAllByRole('button', { name: /^save$/i })[0]);

    await waitFor(async () => {
      expect((await db.localSettings.get('local'))?.paranoidIdleTimeoutMinutes).toBe(7);
      expect((await db.vault.get('vault'))?.idleTimeoutMinutes).toBe(7);
    });

    unmount();
    render(<SecuritySettings />);

    await waitFor(() => expect(screen.getByLabelText('Auto-lock after (minutes idle)')).toHaveValue(7));
  });

  it('keeps the Pomodoro timer and ambient state when the vault locks', async () => {
    await enableParanoid(PASS);
    const endTime = Date.now() + 25 * 60 * 1000;
    usePomodoroStore.setState({
      timerRunning: true,
      timerEndTime: endTime,
      displaySeconds: 25 * 60,
      ambientPlaying: true,
    });

    render(<Gate />);
    expect(screen.getByText('APP CONTENT')).toBeInTheDocument();

    act(() => { lock(); });
    await waitFor(() => expect(screen.getByText('Vault locked')).toBeInTheDocument());

    const pomodoro = usePomodoroStore.getState();
    expect(pomodoro.timerRunning).toBe(true);
    expect(pomodoro.timerEndTime).toBe(endTime);
    expect(pomodoro.displaySeconds).toBe(25 * 60);
    expect(pomodoro.ambientPlaying).toBe(true);
    expect(screen.getByTitle('Stop all')).toBeInTheDocument();
  });
});
