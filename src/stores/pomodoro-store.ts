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

function computeTargetMinute(targetMinute: number, now: Date): number {
  // Always target the next occurrence of :XX, replacing any running timer.
  // Construct target time explicitly with seconds=0, ms=0 for :XX:00 sharp
  const target = new Date(
    now.getFullYear(), now.getMonth(), now.getDate(),
    now.getHours(), targetMinute, 0, 0,
  );

  // If target is at or before now, advance to the next hour
  if (target.getTime() <= now.getTime()) {
    target.setHours(target.getHours() + 1);
  }

  return target.getTime();
}

// The running timer's end, kept across reloads: an update's reload, a re-key's,
// or Android killing the PWA in the background lost it, and no bell ever came.
// Not content — a time — so it is kept in the clear on a Paranoid device too.
const TIMER_END_KEY = 'gtd25-pomodoro-end';
// A timer that ended longer ago than this while the page was gone is dropped
// without a bell; a more recent one completes (and rings) at the first tick.
const LATE_BELL_MS = 10 * 60 * 1000;

function restoredTimerEnd(): number | null {
  try {
    const end = Number(localStorage.getItem(TIMER_END_KEY));
    if (!end) return null;
    if (end < Date.now() - LATE_BELL_MS) {
      localStorage.removeItem(TIMER_END_KEY);
      return null;
    }
    return end;
  } catch {
    return null;
  }
}

const restoredEnd = restoredTimerEnd();

export const usePomodoroStore = create<PomodoroState>((set, get) => ({
  timerRunning: restoredEnd !== null,
  timerEndTime: restoredEnd,
  displaySeconds: restoredEnd !== null ? Math.max(0, Math.ceil((restoredEnd - Date.now()) / 1000)) : 0,
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
    const now = new Date();
    const endTime = computeTargetMinute(25, now);
    const seconds = Math.ceil((endTime - now.getTime()) / 1000);
    set({ timerRunning: true, timerEndTime: endTime, displaySeconds: seconds });
  },

  startColon55: () => {
    const now = new Date();
    const endTime = computeTargetMinute(55, now);
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

usePomodoroStore.subscribe((state, previous) => {
  const end = state.timerRunning ? state.timerEndTime : null;
  if (end === (previous.timerRunning ? previous.timerEndTime : null)) return;
  try {
    if (end) localStorage.setItem(TIMER_END_KEY, String(end));
    else localStorage.removeItem(TIMER_END_KEY);
  } catch { /* storage unavailable: the timer just doesn't survive a reload */ }
});
