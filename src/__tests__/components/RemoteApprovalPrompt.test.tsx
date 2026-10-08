// @vitest-environment jsdom
//
// A request from a device declined a moment ago is held back: a line at the
// bottom (not the overlay) that says why, with "Show request" and "Ignore".
import { render, screen, fireEvent } from '@testing-library/react';
import '../setup-component';

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  showHeld: vi.fn(),
  ignoreHeld: vi.fn(),
}));

vi.mock('../../hooks/use-remote-unlock', () => ({
  useRemoteApprovals: () => ({
    pending: null, held: null, approve: vi.fn(), deny: vi.fn(),
    showHeld: h.showHeld, ignoreHeld: h.ignoreHeld, ...h.state,
  }),
}));
vi.mock('../../sync/remote-unlock', () => ({ DENIAL_PAUSE_MS: 10 * 60_000 }));

import { RemoteApprovalPrompt } from '../../components/security/RemoteApprovalPrompt';

const request = { deviceId: 'lap', fromName: 'Work Laptop', nonce: 'n-1', code: '123456', expiresAt: Date.now() + 60_000, requestDigest: 'd' };

beforeEach(() => {
  h.state = {};
  h.showHeld.mockClear();
  h.ignoreHeld.mockClear();
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
