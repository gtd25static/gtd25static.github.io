// @vitest-environment jsdom
//
// A request from a device declined a moment ago is held back: a line at the
// bottom (not the overlay) that says why, with "Show request" and "Ignore".
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup-component';

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  showHeld: vi.fn(),
  ignoreHeld: vi.fn(),
  ignoreUndeliverable: vi.fn(),
}));

vi.mock('../../hooks/use-remote-unlock', () => ({
  useRemoteApprovals: () => ({
    pending: null, held: null, undeliverable: null, approve: vi.fn(async () => true), deny: vi.fn(),
    showHeld: h.showHeld, ignoreHeld: h.ignoreHeld, ignoreUndeliverable: h.ignoreUndeliverable, ...h.state,
  }),
}));
vi.mock('../../sync/remote-unlock', () => ({ DENIAL_PAUSE_MS: 10 * 60_000 }));

import { RemoteApprovalPrompt } from '../../components/security/RemoteApprovalPrompt';

const request = { deviceId: 'lap', fromName: 'Work Laptop', nonce: 'n-1', code: '123456', expiresAt: Date.now() + 60_000, requestDigest: 'd' };

beforeEach(() => {
  h.state = {};
  h.showHeld.mockClear();
  h.ignoreHeld.mockClear();
  h.ignoreUndeliverable.mockClear();
});
afterEach(() => {
  // Only the stand-ins for Settings: the prompt's own dialog is React's to remove.
  document.querySelectorAll('dialog:not([data-approval-dialog])').forEach((d) => d.remove());
});

it('a held request is a line that says why, not the overlay', () => {
  h.state = { held: { ...request, heldUntil: Date.now() + 5 * 60_000 } };
  render(<RemoteApprovalPrompt />);
  expect(screen.getByRole('status')).toHaveTextContent(/“Work Laptop” is asking to unlock\. Held back: you declined a request from it at/);
  expect(screen.queryByText('123456')).toBeNull(); // the code only once you ask for it
  expect(screen.queryByRole('heading', { name: 'Remote unlock requested' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Show request' }));
  expect(h.showHeld).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Ignore' }));
  expect(h.ignoreHeld).toHaveBeenCalledTimes(1);
});

it('a shown request is the overlay with its code', () => {
  h.state = { pending: request };
  render(<RemoteApprovalPrompt />);
  expect(screen.getByRole('heading', { name: 'Remote unlock requested' })).toBeInTheDocument();
  expect(screen.getByText('123456')).toBeInTheDocument();
  expect(screen.queryByRole('status')).toBeNull();
});

it('the prompt is a modal dialog (top layer): above Settings or any other open dialog', () => {
  const settings = document.createElement('dialog');
  document.body.appendChild(settings);
  settings.showModal();
  h.state = { pending: request };
  render(<RemoteApprovalPrompt />);
  const prompt = screen.getByRole('dialog', { name: 'Remote unlock requested' });
  expect((prompt as HTMLDialogElement).open).toBe(true);
  expect(prompt).toContainElement(screen.getByText('123456'));
});

it('a request that cannot be answered here says why, with Ignore only', () => {
  h.state = { undeliverable: { fromDeviceId: 'lap', fromName: 'Work Laptop', nonce: 'n-9', problem: 'not-for-this-device' } };
  render(<RemoteApprovalPrompt />);
  expect(screen.getByRole('status')).toHaveTextContent(/“Work Laptop” asked to unlock, but not this device/);
  expect(screen.queryByRole('button', { name: 'Show request' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ignore' }));
  expect(h.ignoreUndeliverable).toHaveBeenCalledTimes(1);
});

it.each([
  [{ problem: 'undecryptable' }, /older key of this device/],
  [{ problem: 'bad-signature' }, /not signed by the key this device knows for it/],
  [{ problem: 'dated-ahead', aheadMs: 5 * 60_000 }, /dated 5 min ahead of this device's clock/],
  [{ problem: 'dated-ahead', aheadMs: 30 * 24 * 60 * 60_000 }, /not a clock slip: its key is likely out/],
])('says why: %o', (over, text) => {
  h.state = { undeliverable: { fromDeviceId: 'lap', fromName: 'Work Laptop', nonce: 'n-9', ...over } };
  render(<RemoteApprovalPrompt />);
  expect(screen.getByRole('status')).toHaveTextContent(text);
});

it('a line is a plain bar, and becomes a dialog over an open dialog (where a bar would be inert)', async () => {
  h.state = { held: { ...request, heldUntil: Date.now() + 5 * 60_000 } };
  const { unmount } = render(<RemoteApprovalPrompt />);
  expect(screen.getByRole('status').closest('dialog')).toBeNull();
  unmount();

  const settings = document.createElement('dialog');
  document.body.appendChild(settings);
  settings.showModal();
  render(<RemoteApprovalPrompt />);
  await waitFor(() => expect(screen.getByRole('status').closest('dialog')).not.toBeNull());
  expect((screen.getByRole('status').closest('dialog') as HTMLDialogElement).open).toBe(true);
});
