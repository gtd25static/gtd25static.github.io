// @vitest-environment jsdom
import { vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';

// "Wipe this device and start over" on the sync-password prompt used to delete
// the database by hand: no retry marker, hanging behind a second tab, and Cache
// Storage, sessionStorage and the service worker left behind. It is the panic
// wipe now.

const h = vi.hoisted(() => ({
  panicWipe: vi.fn(async () => undefined),
  needed: null as ((salt: string) => void) | null,
}));
vi.mock('../../lib/panic-wipe', () => ({ panicWipe: h.panicWipe }));
vi.mock('../../sync/sync-engine', () => ({
  onEncryptionPasswordNeeded: (cb: (salt: string) => void) => { h.needed = cb; },
  offEncryptionPasswordNeeded: vi.fn(),
  syncNow: vi.fn(),
}));
vi.mock('../../sync/github-api', () => ({ getFile: vi.fn() }));
vi.mock('../../sync/remote-unlock', () => ({ publishOwnRegistryEntry: vi.fn(async () => true) }));

import { EncryptionPasswordModal } from '../../components/settings/EncryptionPasswordModal';

it('wipes through panicWipe', async () => {
  const user = userEvent.setup();
  render(<EncryptionPasswordModal />);
  act(() => h.needed?.('existing-salt'));

  await user.click(await screen.findByRole('button', { name: /Wipe this device and start over/ }));
  await user.click(await screen.findByRole('button', { name: 'Confirm wipe' }));

  expect(h.panicWipe).toHaveBeenCalledTimes(1);
});
