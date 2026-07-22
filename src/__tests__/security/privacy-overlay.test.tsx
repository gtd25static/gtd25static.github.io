// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../setup-component';

const mockIdleState = vi.fn(() => ({ lastActivityAt: Date.now(), timeoutMs: 15 * 60_000 }));
const mockTouch = vi.fn();

vi.mock('../../db/vault', () => ({
  getVaultIdleState: () => mockIdleState(),
  touchVaultActivity: () => mockTouch(),
}));

import { PrivacyOverlay } from '../../components/security/PrivacyOverlay';

const TIMEOUT_MS = 15 * 60_000;

function idleFor(elapsedMs: number) {
  mockIdleState.mockImplementation(() => ({ lastActivityAt: Date.now() - elapsedMs, timeoutMs: TIMEOUT_MS }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  idleFor(0);
});

afterEach(() => {
  vi.useRealTimers();
});

const veil = () => screen.queryByTestId('privacy-overlay');

describe('PrivacyOverlay', () => {
  it('stays hidden while activity is recent, shows past half the idle window', () => {
    render(<PrivacyOverlay />);
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(veil()).toBeNull();

    idleFor(TIMEOUT_MS * 0.51);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(veil()).not.toBeNull();
  });

  it('shows immediately when the window loses focus or the tab hides', () => {
    render(<PrivacyOverlay />);
    fireEvent.blur(window);
    expect(veil()).not.toBeNull();
  });

  it('dismissal re-arms the vault idle timer — otherwise it would re-show next poll', () => {
    render(<PrivacyOverlay />);
    idleFor(TIMEOUT_MS * 0.6);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(veil()).not.toBeNull();

    fireEvent.pointerMove(window);
    expect(veil()).toBeNull();
    expect(mockTouch).toHaveBeenCalled();

    // With activity re-armed (fresh lastActivityAt), it stays down
    idleFor(0);
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(veil()).toBeNull();
  });

  it('a keypress or regaining focus also lifts the veil', () => {
    render(<PrivacyOverlay />);
    fireEvent.blur(window);
    expect(veil()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'a' });
    expect(veil()).toBeNull();

    fireEvent.blur(window);
    expect(veil()).not.toBeNull();
    fireEvent.focus(window);
    expect(veil()).toBeNull();
    expect(mockTouch).toHaveBeenCalledTimes(2);
  });

  it('pointer movement is ignored while the veil is down (no global activity source)', () => {
    render(<PrivacyOverlay />);
    fireEvent.pointerMove(window);
    fireEvent.pointerMove(window);
    expect(mockTouch).not.toHaveBeenCalled(); // ACR-002: moves alone never touch the vault
  });

  it('shows a countdown to the real auto-lock while veiled', () => {
    render(<PrivacyOverlay />);
    idleFor(TIMEOUT_MS - 90_000); // 1:30 left
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(veil()).not.toBeNull();
    expect(screen.getByText(/Locking in 1:/)).toBeInTheDocument();
  });
});
