// @vitest-environment jsdom
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import '../setup-component';
import { ServiceWorkerProvider } from '../../hooks/use-service-worker';
import { GIT_COMMIT } from '../../lib/constants';

// Background update checks go to the app's host: every one is a visible request
// (and, on a network that rewrites TLS, a chance to be served a different
// worker). They used to run every 30 minutes on a fixed timer — hidden, locked,
// whatever the app was doing. Now the timer is jittered and skips while hidden
// (becoming visible checks anyway), and Paranoid Mode spaces checks 20 minutes
// apart instead of 10.

let visibility: DocumentVisibilityState;
let update: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  update = vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration));
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: () => Promise.resolve({ update }) },
  });
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ commit: GIT_COMMIT }) } as Response)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  localStorage.removeItem('gtd25-paranoid');
});

const MIN = 60_000;

describe('background update checks', () => {
  it('run on the 30-minute timer while the app is visible', async () => {
    render(<ServiceWorkerProvider><div /></ServiceWorkerProvider>);
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('do not run while the app is hidden', async () => {
    visibility = 'hidden';
    render(<ServiceWorkerProvider><div /></ServiceWorkerProvider>);
    await vi.advanceTimersByTimeAsync(65 * MIN);
    expect(update).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('are spaced 20 minutes apart in Paranoid Mode', async () => {
    localStorage.setItem('gtd25-paranoid', '1');
    render(<ServiceWorkerProvider><div /></ServiceWorkerProvider>);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(15 * MIN);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('keep the 10-minute spacing otherwise', async () => {
    render(<ServiceWorkerProvider><div /></ServiceWorkerProvider>);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(15 * MIN);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledTimes(2);
  });
});
