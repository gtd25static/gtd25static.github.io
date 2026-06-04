import { create } from 'zustand';
import type { NudgeContent } from '../lib/nudges';

interface FocusNudgeState {
  nudge: NudgeContent | null;
  show: (nudge: NudgeContent) => void;
  dismiss: () => void;
}

export const useFocusNudgeStore = create<FocusNudgeState>((set) => ({
  nudge: null,
  show: (nudge) => set({ nudge }),
  dismiss: () => set({ nudge: null }),
}));

export function showFocusNudge(nudge: NudgeContent): void {
  useFocusNudgeStore.getState().show(nudge);
}

export function dismissFocusNudge(): void {
  useFocusNudgeStore.getState().dismiss();
}
