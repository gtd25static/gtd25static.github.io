// @vitest-environment jsdom
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 45_000 });
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, __resetVaultStateForTests } from '../../db/vault';
import { SecuritySettings } from '../../components/settings/SecuritySettings';

// The Paranoid panel's recovery backup used to write a plaintext zip straight to
// Downloads. It goes through the export dialog now, encrypted by default.

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.clear();
  await enableParanoid('recovery export dialog passphrase');
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.clear();
});

it('opens the export dialog with an encrypted option selected', async () => {
  const user = userEvent.setup();
  render(<SecuritySettings />);
  await user.click(await screen.findByRole('button', { name: 'Download recovery backup' }));

  expect(await screen.findByRole('heading', { name: 'Download recovery backup' })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Encrypted with a passphrase/ })).toBeChecked();
  expect(screen.getByRole('radio', { name: /Unencrypted/ })).not.toBeChecked();
});
