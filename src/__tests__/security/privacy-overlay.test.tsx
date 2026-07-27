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

/** Put the tab in the background the way a real switch-away does. */
function background() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  fireEvent.blur(window);
  fireEvent(document, new Event('visibilitychange'));
}

function foreground() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  fireEvent(document, new Event('visibilitychange'));
  fireEvent.focus(window);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  idleFor(0);
});

afterEach(() => {
  vi.useRealTimers();
});

const veil = () => screen.queryByTestId('privacy-overlay');

describe('PrivacyOverlay', () => {
  it('waits out half the time left before the auto-lock, then veils', () => {
    render(<PrivacyOverlay />);
    background();
    expect(veil()).toBeNull(); // not on the way out

    // Nothing at just under half of the 15 min that were left…
    act(() => { vi.advanceTimersByTime(TIMEOUT_MS / 2 - 10_000); });
    expect(veil()).toBeNull();
    // …and up once that half has passed.
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(veil()).not.toBeNull();
  });

  it('measures the half against what was actually left, not the whole window', () => {
    idleFor(TIMEOUT_MS - 60_000); // one minute to go when we walk away
    render(<PrivacyOverlay />);
    background();

    act(() => { vi.advanceTimersByTime(20_000); });
    expect(veil()).toBeNull();
    act(() => { vi.advanceTimersByTime(12_000); }); // past 30s = half of what was left
    expect(veil()).not.toBeNull();
  });

  it('never veils an app in the foreground, however long it sits untouched', () => {
    // The pre-2026-07-27 behaviour raised the veil here; being on screen and
    // idle is no longer enough, background is now required.
    render(<PrivacyOverlay />);
    idleFor(TIMEOUT_MS * 0.9);
    act(() => { vi.advanceTimersByTime(TIMEOUT_MS * 0.9); });
    expect(veil()).toBeNull();
  });

  it('coming back before the countdown expires cancels it', () => {
    render(<PrivacyOverlay />);
    background();
    act(() => { vi.advanceTimersByTime(TIMEOUT_MS / 4); });
    foreground();

    // Well past the original deadline, but we are here now.
    act(() => { vi.advanceTimersByTime(TIMEOUT_MS); });
    expect(veil()).toBeNull();
  });

  it('with `immediate`, veils on the way out instead of counting down', () => {
    render(<PrivacyOverlay immediate />);
    fireEvent.blur(window);
    expect(veil()).not.toBeNull();
  });

  it('dismissal re-arms the vault idle timer and restarts the countdown while still away', () => {
    render(<PrivacyOverlay />);
    background();
    act(() => { vi.advanceTimersByTime(TIMEOUT_MS / 2 + 2_000); });
    expect(veil()).not.toBeNull();

    // A mouse move over an unfocused window wakes it: activity is recorded…
    idleFor(0);
    fireEvent.pointerMove(window);
    expect(veil()).toBeNull();
    expect(mockTouch).toHaveBeenCalled();

    // …and because we never came back, it veils again after the new half.
    act(() => { vi.advanceTimersByTime(TIMEOUT_MS / 2 - 10_000); });
    expect(veil()).toBeNull();
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(veil()).not.toBeNull();
  });

  it('in `immediate` mode a dismissal sticks until the next backgrounding', () => {
    render(<PrivacyOverlay immediate />);
    fireEvent.blur(window);
    expect(veil()).not.toBeNull();

    fireEvent.pointerMove(window);
    expect(veil()).toBeNull();
    act(() => { vi.advanceTimersByTime(TIMEOUT_MS); });
    expect(veil()).toBeNull(); // no countdown re-raises it

    fireEvent.blur(window);
    expect(veil()).not.toBeNull();
  });

  it('a keypress or regaining focus also lifts the veil', () => {
    render(<PrivacyOverlay immediate />);
    fireEvent.blur(window);
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
    // Pin the activity to an absolute instant so the remaining time really
    // shrinks as the fake clock advances (idleFor slides it along with now).
    const activityAt = Date.now() - (TIMEOUT_MS - 180_000); // 3 min left
    mockIdleState.mockImplementation(() => ({ lastActivityAt: activityAt, timeoutMs: TIMEOUT_MS }));
    render(<PrivacyOverlay />);
    background();

    act(() => { vi.advanceTimersByTime(92_000); }); // past half of the 3 min
    expect(veil()).not.toBeNull();
    expect(screen.getByText(/Locking in 1:2[0-9]/)).toBeInTheDocument();
  });
});
