import { create } from 'zustand';

interface PomodoroState {
  timerRunning: boolean;
  timerEndTime: number | null; // absolute timestamp
  displaySeconds: number;
  ambientPlaying: boolean;
  pomodoroSettingsOpen: boolean;

  // Timer actions
  startPlus25: () => void;
  startColon25: () => void;
  startColon55: () => void;
  stopTimer: () => void;
  tick: () => { completed: boolean };

  // Ambient
  toggleAmbient: () => void;
  stopAll: () => void;

  // Settings modal
  setPomodoroSettingsOpen: (open: boolean) => void;
}

function computeTargetMinute(targetMinute: number, now: Date, currentEndTime: number | null): number {
  const currentMinute = now.getMinutes();
  const currentSeconds = now.getSeconds();

  // If timer is already running and was set by a colon button, extend by 60 minutes
  if (currentEndTime !== null) {
    return currentEndTime + 60 * 60 * 1000;
  }

  // Compute target time for the next occurrence of :targetMinute
  const target = new Date(now);
  target.setSeconds(0, 0);
  target.setMinutes(targetMinute);

  // If we're already past that minute (or exactly at it), target next hour
  if (currentMinute > targetMinute || (currentMinute === targetMinute && currentSeconds > 0)) {
    target.setHours(target.getHours() + 1);
  }

  return target.getTime();
}

export const usePomodoroStore = create<PomodoroState>((set, get) => ({
  timerRunning: false,
  timerEndTime: null,
  displaySeconds: 0,
  ambientPlaying: false,
  pomodoroSettingsOpen: false,

  startPlus25: () => {
    const state = get();
    const now = Date.now();
    const endTime = state.timerRunning && state.timerEndTime
      ? state.timerEndTime + 25 * 60 * 1000
      : now + 25 * 60 * 1000;
    const seconds = Math.ceil((endTime - now) / 1000);
    set({ timerRunning: true, timerEndTime: endTime, displaySeconds: seconds });
  },

  startColon25: () => {
    const state = get();
    const now = new Date();
    const endTime = computeTargetMinute(25, now, state.timerRunning ? state.timerEndTime : null);
    const seconds = Math.ceil((endTime - now.getTime()) / 1000);
    set({ timerRunning: true, timerEndTime: endTime, displaySeconds: seconds });
  },

  startColon55: () => {
    const state = get();
    const now = new Date();
    const endTime = computeTargetMinute(55, now, state.timerRunning ? state.timerEndTime : null);
    const seconds = Math.ceil((endTime - now.getTime()) / 1000);
    set({ timerRunning: true, timerEndTime: endTime, displaySeconds: seconds });
  },

  stopTimer: () => {
    set({ timerRunning: false, timerEndTime: null, displaySeconds: 0 });
  },

  tick: () => {
    const state = get();
    if (!state.timerRunning || !state.timerEndTime) return { completed: false };

    const now = Date.now();
    const remaining = Math.ceil((state.timerEndTime - now) / 1000);

    if (remaining <= 0) {
      set({ timerRunning: false, timerEndTime: null, displaySeconds: 0 });
      return { completed: true };
    }

    set({ displaySeconds: remaining });
    return { completed: false };
  },

  toggleAmbient: () => {
    set((state) => ({ ambientPlaying: !state.ambientPlaying }));
  },

  stopAll: () => {
    set({
      timerRunning: false,
      timerEndTime: null,
      displaySeconds: 0,
      ambientPlaying: false,
    });
  },

  setPomodoroSettingsOpen: (open) => set({ pomodoroSettingsOpen: open }),
}));
