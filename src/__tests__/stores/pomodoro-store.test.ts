import { usePomodoroStore } from '../../stores/pomodoro-store';

function getState() {
  return usePomodoroStore.getState();
}

describe('pomodoro-store', () => {
  beforeEach(() => {
    // Reset store state
    usePomodoroStore.setState({
      timerRunning: false,
      timerEndTime: null,
      displaySeconds: 0,
      ambientPlaying: false,
      pomodoroSettingsOpen: false,
    });
  });

  describe('startPlus25', () => {
    it('starts a 25-minute timer', () => {
      const before = Date.now();
      getState().startPlus25();
      const state = getState();

      expect(state.timerRunning).toBe(true);
      expect(state.timerEndTime).toBeGreaterThanOrEqual(before + 25 * 60 * 1000 - 100);
      expect(state.timerEndTime).toBeLessThanOrEqual(before + 25 * 60 * 1000 + 100);
      expect(state.displaySeconds).toBeGreaterThan(24 * 60);
      expect(state.displaySeconds).toBeLessThanOrEqual(25 * 60);
    });

    it('extends timer by 25 minutes when already running', () => {
      getState().startPlus25();
      const firstEnd = getState().timerEndTime!;

      getState().startPlus25();
      const secondEnd = getState().timerEndTime!;

      // Should have added 25 minutes to the existing end time
      expect(secondEnd).toBeGreaterThanOrEqual(firstEnd + 25 * 60 * 1000 - 100);
      expect(secondEnd).toBeLessThanOrEqual(firstEnd + 25 * 60 * 1000 + 100);
    });
  });

  describe('startColon25', () => {
    it('sets timer to next :25 of the hour', () => {
      getState().startColon25();
      const state = getState();

      expect(state.timerRunning).toBe(true);
      expect(state.timerEndTime).toBeDefined();

      const target = new Date(state.timerEndTime!);
      expect(target.getMinutes()).toBe(25);
      expect(target.getSeconds()).toBe(0);
      expect(target.getMilliseconds()).toBe(0);
    });

    it('targets :25:00 sharp even when pressed mid-second', () => {
      // The timer should always target :25:00.000, never :25:30 or similar
      getState().startColon25();
      const state = getState();
      const target = new Date(state.timerEndTime!);

      expect(target.getMinutes()).toBe(25);
      expect(target.getSeconds()).toBe(0);
      expect(target.getMilliseconds()).toBe(0);
      expect(state.displaySeconds).toBeGreaterThan(0);
    });

    it('targets next hour if past :25', () => {
      // This test verifies the logic works regardless of current time
      getState().startColon25();
      const state = getState();
      const now = new Date();
      const target = new Date(state.timerEndTime!);

      // Target should be in the future
      expect(target.getTime()).toBeGreaterThan(now.getTime() - 1000);
      expect(target.getMinutes()).toBe(25);
    });

    it('extends by 60 minutes on second click', () => {
      getState().startColon25();
      const firstEnd = getState().timerEndTime!;

      getState().startColon25();
      const secondEnd = getState().timerEndTime!;

      expect(secondEnd).toBeGreaterThanOrEqual(firstEnd + 60 * 60 * 1000 - 100);
      expect(secondEnd).toBeLessThanOrEqual(firstEnd + 60 * 60 * 1000 + 100);
    });
  });

  describe('startColon55', () => {
    it('sets timer to next :55 of the hour', () => {
      getState().startColon55();
      const state = getState();

      expect(state.timerRunning).toBe(true);
      const target = new Date(state.timerEndTime!);
      expect(target.getMinutes()).toBe(55);
      expect(target.getSeconds()).toBe(0);
      expect(target.getMilliseconds()).toBe(0);
    });
  });

  describe('tick', () => {
    it('decrements displaySeconds', () => {
      getState().startPlus25();
      const initialSeconds = getState().displaySeconds;

      // Simulate time passing
      const endTime = getState().timerEndTime!;
      usePomodoroStore.setState({ timerEndTime: endTime - 5000 });

      const result = getState().tick();

      expect(result.completed).toBe(false);
      expect(getState().displaySeconds).toBeLessThan(initialSeconds);
    });

    it('completes when timer reaches 0', () => {
      getState().startPlus25();
      // Set end time to the past
      usePomodoroStore.setState({ timerEndTime: Date.now() - 1000 });

      const result = getState().tick();

      expect(result.completed).toBe(true);
      expect(getState().timerRunning).toBe(false);
      expect(getState().timerEndTime).toBeNull();
      expect(getState().displaySeconds).toBe(0);
    });

    it('returns completed=false when timer is not running', () => {
      const result = getState().tick();
      expect(result.completed).toBe(false);
    });
  });

  describe('stopTimer', () => {
    it('stops the timer and resets state', () => {
      getState().startPlus25();
      getState().stopTimer();

      const state = getState();
      expect(state.timerRunning).toBe(false);
      expect(state.timerEndTime).toBeNull();
      expect(state.displaySeconds).toBe(0);
    });
  });

  describe('toggleAmbient', () => {
    it('toggles ambientPlaying', () => {
      expect(getState().ambientPlaying).toBe(false);
      getState().toggleAmbient();
      expect(getState().ambientPlaying).toBe(true);
      getState().toggleAmbient();
      expect(getState().ambientPlaying).toBe(false);
    });
  });

  describe('stopAll', () => {
    it('stops timer and ambient', () => {
      getState().startPlus25();
      getState().toggleAmbient();

      getState().stopAll();
      const state = getState();

      expect(state.timerRunning).toBe(false);
      expect(state.ambientPlaying).toBe(false);
      expect(state.timerEndTime).toBeNull();
      expect(state.displaySeconds).toBe(0);
    });
  });

  describe('settings modal', () => {
    it('toggles pomodoroSettingsOpen', () => {
      expect(getState().pomodoroSettingsOpen).toBe(false);
      getState().setPomodoroSettingsOpen(true);
      expect(getState().pomodoroSettingsOpen).toBe(true);
      getState().setPomodoroSettingsOpen(false);
      expect(getState().pomodoroSettingsOpen).toBe(false);
    });
  });
});
