// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import '../setup-component';
import { usePomodoroClock } from '../../hooks/use-pomodoro-clock';
import { usePomodoroStore } from '../../stores/pomodoro-store';

const mockShowTimerNotification = vi.fn();
vi.mock('../../lib/notifications', () => ({
  showTimerNotification: () => mockShowTimerNotification(),
  requestNotificationPermission: vi.fn(),
}));
vi.mock('../../lib/audio-engine', () => ({
  audioEngine: {
    stopTicking: vi.fn(),
    startTicking: vi.fn(),
    playBell: vi.fn(),
    stopAll: vi.fn(),
    stopAllAmbient: vi.fn(),
    setMasterVolume: vi.fn(),
  },
}));
vi.mock('../../lib/media-session', () => ({
  updateMediaSession: vi.fn(),
  clearMediaSession: vi.fn(),
  registerMediaSessionHandlers: vi.fn(),
}));
vi.mock('../../lib/pomodoro-audio', () => ({
  loadPomodoroSettings: vi.fn().mockResolvedValue({ bellEnabled: true }),
  startAmbientFromActivePreset: vi.fn(),
}));

describe('pomodoro completion', { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePomodoroStore.setState({ timerRunning: false, timerEndTime: null, displaySeconds: 0, ambientPlaying: false });
  });

  // On Android `new Notification()` threw inside the completion handler, which
  // then never reset ambientPlaying: the Stop button stayed up and the next
  // session didn't restart the ambient sound.
  it('resets ambient state even when showing the notification throws', async () => {
    mockShowTimerNotification.mockImplementation(() => {
      throw new TypeError("Failed to construct 'Notification': Illegal constructor.");
    });
    renderHook(() => usePomodoroClock());
    act(() => {
      usePomodoroStore.setState({ timerRunning: true, timerEndTime: Date.now() - 1_000, ambientPlaying: true });
    });

    // The completion check also runs when the page becomes visible.
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    await waitFor(() => expect(usePomodoroStore.getState().ambientPlaying).toBe(false));
    expect(usePomodoroStore.getState().timerRunning).toBe(false);
    expect(mockShowTimerNotification).toHaveBeenCalled();
  });
});
